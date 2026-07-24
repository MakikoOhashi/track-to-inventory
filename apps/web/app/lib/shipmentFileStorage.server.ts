import type {
  GetFileUrlsInput,
  GetFileUrlsResult,
  UploadShipmentFileInput,
  UploadShipmentFileResult,
} from "@track-to-inventory/shared";
import {
  hasInvalidPathSegment,
  isUnsafeStoragePath,
  normalizeFilePaths,
  validateUploadFile,
} from "@track-to-inventory/shared/ocr-runtime";
import { createSupabaseAdminClient } from "~/lib/supabase.server";
import { normalizeShopDomain } from "~/utils/shopDomain";

export const SHIPMENT_FILES_BUCKET = "shipment-files";
export const SHOPS_PATH_PREFIX = "shops";

/** Matches Render upload signed-URL TTL. */
export const UPLOAD_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Matches Render get-file-url signed-URL TTL. */
export const GET_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

export const ALLOWED_SHIPMENT_FILE_TYPES = ["invoice", "pl", "si", "other"] as const;

export type ShipmentFileType = (typeof ALLOWED_SHIPMENT_FILE_TYPES)[number];

export class ShipmentFileStorageError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ShipmentFileStorageError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Storage boundary for shipment files.
 * Supabase today; swap the implementation later for R2 without changing routes.
 */
export type ShipmentFileStorage = {
  assertShipmentOwnedByShop: (siNumber: string, shop: string) => Promise<void>;
  uploadShipmentFile: (
    input: UploadShipmentFileInput & { shop: string },
  ) => Promise<UploadShipmentFileResult>;
  createSignedFileUrls: (
    input: GetFileUrlsInput & { shop: string },
  ) => Promise<GetFileUrlsResult>;
};

type ShipmentFileColumns = {
  invoice_url: string | null;
  pl_url: string | null;
  si_url: string | null;
  other_url: string | null;
};

function isAllowedFileType(type: string): type is ShipmentFileType {
  return (ALLOWED_SHIPMENT_FILE_TYPES as readonly string[]).includes(type);
}

/**
 * Build a path-safe shop scope from an already-authenticated shop domain.
 * Never accepts body/query shop strings.
 */
export function shopStorageScope(shop: string): string {
  const normalized = normalizeShopDomain(shop);
  if (!normalized || hasInvalidPathSegment(normalized)) {
    throw new ShipmentFileStorageError("INVALID_SHOP", "不正なファイルパスです", 400);
  }
  return normalized;
}

/** New uploads only: shops/{shop}/{siNumber}/{type}.{ext} */
export function buildShopScopedShipmentFilePath(
  shop: string,
  siNumber: string,
  type: string,
  fileExt: string,
): string {
  const scope = shopStorageScope(shop);
  if (!siNumber || hasInvalidPathSegment(siNumber) || hasInvalidPathSegment(type) || hasInvalidPathSegment(fileExt)) {
    throw new ShipmentFileStorageError("INVALID_PATH", "不正なファイルパスです", 400);
  }
  return `${SHOPS_PATH_PREFIX}/${scope}/${siNumber}/${type}.${fileExt}`;
}

/** Legacy (pre-F.1) path: {siNumber}/{type}.{ext} */
export function buildLegacyShipmentFilePath(siNumber: string, type: string, fileExt: string): string {
  if (!siNumber || hasInvalidPathSegment(siNumber) || hasInvalidPathSegment(type) || hasInvalidPathSegment(fileExt)) {
    throw new ShipmentFileStorageError("INVALID_PATH", "不正なファイルパスです", 400);
  }
  return `${siNumber}/${type}.${fileExt}`;
}

export function isShopScopedObjectPath(objectPath: string): boolean {
  return objectPath.startsWith(`${SHOPS_PATH_PREFIX}/`);
}

export function shopScopeFromObjectPath(objectPath: string): string | null {
  if (!isShopScopedObjectPath(objectPath)) return null;
  const parts = objectPath.split("/");
  // shops / {shop} / {si} / file
  if (parts.length < 4) return null;
  return parts[1] || null;
}

export function pathBelongsToShopScope(objectPath: string, shop: string): boolean {
  const scope = shopStorageScope(shop);
  return objectPath.startsWith(`${SHOPS_PATH_PREFIX}/${scope}/`);
}

export function pathBelongsToSi(objectPath: string, siNumber: string, shop?: string): boolean {
  if (shop && isShopScopedObjectPath(objectPath)) {
    const scope = shopStorageScope(shop);
    const prefix = `${SHOPS_PATH_PREFIX}/${scope}/${siNumber}/`;
    return objectPath.startsWith(prefix);
  }

  if (isShopScopedObjectPath(objectPath)) {
    // Scoped path without matching shop context is not "this SI" for callers.
    const parts = objectPath.split("/");
    return parts.length >= 4 && parts[2] === siNumber;
  }

  const prefix = `${siNumber}/`;
  return objectPath === siNumber || objectPath.startsWith(prefix);
}

/**
 * Normalize DB/UI values into a Storage object key under shipment-files.
 * Accepts bare keys or Supabase Storage URLs; rejects traversal.
 */
export function resolveStorageObjectPath(rawPath: string): string | null {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  let candidate = trimmed;

  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      const markers = [
        `/storage/v1/object/sign/${SHIPMENT_FILES_BUCKET}/`,
        `/storage/v1/object/public/${SHIPMENT_FILES_BUCKET}/`,
        `/storage/v1/object/authenticated/${SHIPMENT_FILES_BUCKET}/`,
        `/${SHIPMENT_FILES_BUCKET}/`,
      ];
      const pathname = url.pathname;
      let matched = false;
      for (const marker of markers) {
        const idx = pathname.indexOf(marker);
        if (idx >= 0) {
          candidate = decodeURIComponent(pathname.slice(idx + marker.length));
          matched = true;
          break;
        }
      }
      if (!matched) {
        return null;
      }
    }
  } catch {
    return null;
  }

  // Reject encoded / raw traversal after decode.
  if (
    isUnsafeStoragePath(candidate) ||
    candidate.includes("%2e%2e") ||
    candidate.includes("%2E%2E") ||
    candidate.includes("%2f") ||
    candidate.includes("%2F")
  ) {
    return null;
  }

  return candidate;
}

function dbValueReferencesObjectPath(dbValue: string | null | undefined, objectPath: string): boolean {
  if (!dbValue || typeof dbValue !== "string") return false;
  if (dbValue === objectPath) return true;

  const resolved = resolveStorageObjectPath(dbValue);
  return resolved === objectPath;
}

function shipmentReferencesObjectPath(columns: ShipmentFileColumns, objectPath: string): boolean {
  return (
    dbValueReferencesObjectPath(columns.invoice_url, objectPath) ||
    dbValueReferencesObjectPath(columns.pl_url, objectPath) ||
    dbValueReferencesObjectPath(columns.si_url, objectPath) ||
    dbValueReferencesObjectPath(columns.other_url, objectPath)
  );
}

async function countShopsWithSi(siNumber: string): Promise<number> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("shipments")
    .select("shop_id")
    .eq("si_number", siNumber);

  if (error) {
    throw new ShipmentFileStorageError("DB_ERROR", "データベースエラー", 500);
  }

  const shops = new Set((data || []).map((row) => row.shop_id).filter(Boolean));
  return shops.size;
}

async function loadShipmentFileColumns(siNumber: string, shop: string): Promise<ShipmentFileColumns> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("shipments")
    .select("invoice_url, pl_url, si_url, other_url")
    .eq("si_number", siNumber)
    .eq("shop_id", shop)
    .maybeSingle();

  if (error) {
    throw new ShipmentFileStorageError("DB_ERROR", "データベースエラー", 500);
  }

  if (!data) {
    throw new ShipmentFileStorageError("NOT_FOUND", "ファイルが見つかりません", 404);
  }

  return data as ShipmentFileColumns;
}

async function createSignedUrlForPath(
  objectPath: string,
  ttlSeconds: number,
): Promise<string> {
  const supabase = createSupabaseAdminClient();
  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
    .from(SHIPMENT_FILES_BUCKET)
    .createSignedUrl(objectPath, ttlSeconds);

  if (signedUrlError || !signedUrlData?.signedUrl) {
    throw new ShipmentFileStorageError(
      "SIGNED_URL_FAILED",
      signedUrlError
        ? `署名付きURL生成エラー: ${signedUrlError.message}`
        : "署名付きURLが生成されませんでした",
      500,
    );
  }

  return signedUrlData.signedUrl;
}

/**
 * Decide which Storage object to sign for a requested path.
 * New shop-scoped paths are preferred; legacy paths only when uniquely attributable.
 */
export async function resolveReadableObjectPath(params: {
  rawPath: string;
  siNumber: string;
  shop: string;
  columns: ShipmentFileColumns;
  shopsWithSameSi: number;
}): Promise<{ objectPath: string } | { denyReason: string }> {
  const { rawPath, siNumber, shop, columns, shopsWithSameSi } = params;
  const objectPath = resolveStorageObjectPath(rawPath);
  if (!objectPath) {
    return { denyReason: `不正なファイルパス: ${rawPath}` };
  }

  // Prefer / only allow this shop's scoped prefix.
  if (isShopScopedObjectPath(objectPath)) {
    if (!pathBelongsToShopScope(objectPath, shop)) {
      return { denyReason: `アクセス権限がありません: ${rawPath}` };
    }
    if (!pathBelongsToSi(objectPath, siNumber, shop)) {
      return { denyReason: `アクセス権限がありません: ${rawPath}` };
    }
    return { objectPath };
  }

  // Legacy path: require unique SI attribution + DB reference on this shipment.
  if (!pathBelongsToSi(objectPath, siNumber)) {
    return { denyReason: `アクセス権限がありません: ${rawPath}` };
  }

  if (shopsWithSameSi !== 1) {
    return { denyReason: `アクセス権限がありません: ${rawPath}` };
  }

  if (!shipmentReferencesObjectPath(columns, objectPath)) {
    return { denyReason: `アクセス権限がありません: ${rawPath}` };
  }

  return { objectPath };
}

function createSupabaseShipmentFileStorage(): ShipmentFileStorage {
  return {
    async assertShipmentOwnedByShop(siNumber, shop) {
      if (!siNumber || hasInvalidPathSegment(siNumber)) {
        throw new ShipmentFileStorageError("INVALID_SI", "不正なファイルパスです", 400);
      }

      const supabase = createSupabaseAdminClient();
      const { data, error } = await supabase
        .from("shipments")
        .select("shop_id")
        .eq("si_number", siNumber)
        .eq("shop_id", shop)
        .maybeSingle();

      if (error) {
        throw new ShipmentFileStorageError("DB_ERROR", "データベースエラー", 500);
      }

      if (!data) {
        throw new ShipmentFileStorageError("NOT_FOUND", "ファイルが見つかりません", 404);
      }
    },

    async uploadShipmentFile(input) {
      const { siNumber, type, file, shop } = input;

      if (!siNumber || !type || !(file instanceof File)) {
        throw new ShipmentFileStorageError("MISSING_FIELDS", "必須フィールドが不足しています", 400);
      }

      if (!isAllowedFileType(type) || hasInvalidPathSegment(type) || hasInvalidPathSegment(siNumber)) {
        throw new ShipmentFileStorageError("INVALID_PATH", "不正なファイルパスです", 400);
      }

      // Ensure shop is a validated domain before any Storage write.
      shopStorageScope(shop);
      await this.assertShipmentOwnedByShop(siNumber, shop);

      let fileExt: string;
      try {
        fileExt = validateUploadFile(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : "ファイル検証に失敗しました";
        if (message.includes("最大10MB")) {
          throw new ShipmentFileStorageError("FILE_TOO_LARGE", message, 413);
        }
        if (message.includes("許可されていない")) {
          throw new ShipmentFileStorageError("UNSUPPORTED_TYPE", message, 415);
        }
        if (message.includes("空のファイル")) {
          throw new ShipmentFileStorageError("EMPTY_FILE", message, 400);
        }
        throw new ShipmentFileStorageError("VALIDATION", message, 400);
      }

      const filePath = buildShopScopedShipmentFilePath(shop, siNumber, type, fileExt);
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const supabase = createSupabaseAdminClient();

      const { error: uploadError } = await supabase.storage
        .from(SHIPMENT_FILES_BUCKET)
        .upload(filePath, fileBytes, {
          upsert: true,
          contentType: file.type,
        });

      if (uploadError) {
        throw new ShipmentFileStorageError(
          "UPLOAD_FAILED",
          `アップロードエラー: ${uploadError.message}`,
          500,
        );
      }

      const signedUrl = await createSignedUrlForPath(filePath, UPLOAD_SIGNED_URL_TTL_SECONDS);

      return {
        filePath,
        signedUrl,
        message: "ファイルが正常にアップロードされました",
      };
    },

    async createSignedFileUrls(input) {
      const { shop, siNumber } = input;
      const paths = normalizeFilePaths(input.filePaths).filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );

      if (!paths.length) {
        throw new ShipmentFileStorageError("NO_PATHS", "ファイルパスが指定されていません", 400);
      }

      if (typeof siNumber !== "string" || !siNumber) {
        throw new ShipmentFileStorageError("SI_REQUIRED", "SI番号が必要です", 400);
      }

      shopStorageScope(shop);
      await this.assertShipmentOwnedByShop(siNumber, shop);

      const [columns, shopsWithSameSi] = await Promise.all([
        loadShipmentFileColumns(siNumber, shop),
        countShopsWithSi(siNumber),
      ]);

      const signedUrls: Record<string, string> = {};
      const errors: string[] = [];

      for (const rawPath of paths) {
        const resolved = await resolveReadableObjectPath({
          rawPath,
          siNumber,
          shop,
          columns,
          shopsWithSameSi,
        });

        if ("denyReason" in resolved) {
          errors.push(resolved.denyReason);
          continue;
        }

        try {
          const signedUrl = await createSignedUrlForPath(
            resolved.objectPath,
            GET_SIGNED_URL_TTL_SECONDS,
          );
          signedUrls[rawPath] = signedUrl;
          if (rawPath !== resolved.objectPath) {
            signedUrls[resolved.objectPath] = signedUrl;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "署名付きURLが生成されませんでした";
          errors.push(`${resolved.objectPath}: ${message}`);
        }
      }

      const firstPath = paths[0];
      return {
        signedUrls,
        signedUrl: paths.length === 1 && firstPath ? signedUrls[firstPath] : undefined,
        errors: errors.length > 0 ? errors : undefined,
      };
    },
  };
}

let storageSingleton: ShipmentFileStorage | null = null;

export function getShipmentFileStorage(): ShipmentFileStorage {
  if (!storageSingleton) {
    storageSingleton = createSupabaseShipmentFileStorage();
  }
  return storageSingleton;
}
