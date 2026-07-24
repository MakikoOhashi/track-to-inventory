import type {
  GetFileUrlsInput,
  GetFileUrlsResult,
  UploadShipmentFileInput,
  UploadShipmentFileResult,
} from "@track-to-inventory/shared";
import {
  buildShipmentFilePath,
  hasInvalidPathSegment,
  isUnsafeStoragePath,
  normalizeFilePaths,
  validateUploadFile,
} from "@track-to-inventory/shared/ocr-runtime";
import { createSupabaseAdminClient } from "~/lib/supabase.server";

export const SHIPMENT_FILES_BUCKET = "shipment-files";

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

function isAllowedFileType(type: string): type is ShipmentFileType {
  return (ALLOWED_SHIPMENT_FILE_TYPES as readonly string[]).includes(type);
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

  if (isUnsafeStoragePath(candidate)) {
    return null;
  }

  return candidate;
}

function pathBelongsToSi(objectPath: string, siNumber: string): boolean {
  const prefix = `${siNumber}/`;
  return objectPath === siNumber || objectPath.startsWith(prefix);
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

      const filePath = buildShipmentFilePath(siNumber, type, fileExt);
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

      const { data: signedUrlData, error: signedUrlError } = await supabase.storage
        .from(SHIPMENT_FILES_BUCKET)
        .createSignedUrl(filePath, UPLOAD_SIGNED_URL_TTL_SECONDS);

      if (signedUrlError || !signedUrlData?.signedUrl) {
        throw new ShipmentFileStorageError(
          "SIGNED_URL_FAILED",
          signedUrlError
            ? `署名付きURL生成エラー: ${signedUrlError.message}`
            : "署名付きURLが生成されませんでした",
          500,
        );
      }

      return {
        filePath,
        signedUrl: signedUrlData.signedUrl,
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

      await this.assertShipmentOwnedByShop(siNumber, shop);

      const supabase = createSupabaseAdminClient();
      const signedUrls: Record<string, string> = {};
      const errors: string[] = [];

      for (const rawPath of paths) {
        const objectPath = resolveStorageObjectPath(rawPath);
        if (!objectPath) {
          errors.push(`不正なファイルパス: ${rawPath}`);
          continue;
        }

        if (!pathBelongsToSi(objectPath, siNumber)) {
          errors.push(`アクセス権限がありません: ${rawPath}`);
          continue;
        }

        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
          .from(SHIPMENT_FILES_BUCKET)
          .createSignedUrl(objectPath, GET_SIGNED_URL_TTL_SECONDS);

        if (signedUrlError || !signedUrlData?.signedUrl) {
          errors.push(
            `${objectPath}: ${signedUrlError?.message ?? "署名付きURLが生成されませんでした"}`,
          );
          continue;
        }

        // Key by the raw path the UI sent so Modal cache lookups keep working.
        signedUrls[rawPath] = signedUrlData.signedUrl;
        if (rawPath !== objectPath) {
          signedUrls[objectPath] = signedUrlData.signedUrl;
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
