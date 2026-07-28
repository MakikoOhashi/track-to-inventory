import { data as json, type ActionFunctionArgs } from "react-router";
import { ApiVersion, LogSeverity, shopifyApi } from "@shopify/shopify-api";
import { randomUUID } from "node:crypto";
import sessionStorage from "~/sessionStorage.server";
import { getOptionalTtiDb } from "~/lib/cloudflareBindings.server";
import { createShopifySessionRepository } from "~/lib/d1/shopifySessions.server";
import {
  AUTH2B_CANARY_CONFIRMATION,
  AUTH2B_CANARY_SHOP,
  runAuth2bCanaryExchange,
} from "~/lib/auth2bCanaryExchange.server";

const REQUIRED_SCHEMA_COLUMNS = new Set([
  "token_ciphertext",
  "token_expires_at",
  "token_fingerprint",
  "token_generation",
]);
const LOCK_TABLE = "auth2b_canary_locks";

function statusFor(result: { type: string; error?: string }): number {
  if (
    result.type.endsWith("_stored") ||
    result.type === "auth2b_canary_eligible"
  ) {
    return 200;
  }
  if (result.error === "operator_schema_not_ready") return 503;
  return 409;
}

function buildOfficialShopifyApi() {
  const appUrl = new URL(process.env.SHOPIFY_APP_URL!);
  return shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY!,
    apiSecretKey: process.env.SHOPIFY_API_SECRET!,
    scopes: process.env.SCOPES!.split(","),
    hostName: appUrl.host,
    hostScheme: appUrl.protocol.replace(":", "") as "http" | "https",
    apiVersion: ApiVersion.January26,
    isEmbeddedApp: true,
    logger: {
      level: LogSeverity.Error,
      httpRequests: false,
      log: () => undefined,
    },
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const db = getOptionalTtiDb();
  if (!db) {
    return json(
      { type: "auth2b_canary_rejected", error: "binding_missing" },
      { status: 503 },
    );
  }

  // Body, query, and headers never select a shop. A missing/mismatched secret
  // is always a dry-run; only the separately provisioned operator secret can
  // authorize the irreversible exchange.
  const confirmation = request.headers.get("x-auth2b-operator-confirmation");
  const configuredConfirmation =
    process.env.AUTH2B_OPERATOR_CONFIRMATION?.trim();
  const execute = Boolean(
    configuredConfirmation &&
    configuredConfirmation !== AUTH2B_CANARY_CONFIRMATION &&
    confirmation === configuredConfirmation,
  );
  const repo = createShopifySessionRepository(db);
  const sessionId = `offline_${AUTH2B_CANARY_SHOP}`;

  const ownerId = randomUUID();
  try {
    const result = await runAuth2bCanaryExchange(
      {
        inspectSchema: async () => {
          const columns = await db
            .prepare("SELECT name FROM pragma_table_info('shopify_sessions')")
            .all<{ name: string }>();
          const actual = new Set(
            (columns.results ?? []).map((column) => column.name),
          );
          const lockTable = await db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(LOCK_TABLE)
            .first<{ name: string }>();
          return (
            [...REQUIRED_SCHEMA_COLUMNS].every((column) =>
              actual.has(column),
            ) && lockTable?.name === LOCK_TABLE
          );
        },
        inspect: async () => {
          const inspected = await repo.inspectSession(sessionId);
          if (inspected.status !== "live") return { row: null };
          return {
            row: {
              id: inspected.row.id,
              shop: inspected.row.shop,
              isOnline: inspected.row.is_online === 1,
              tokenCiphertext: inspected.row.token_ciphertext,
              tokenExpiresAt: inspected.row.token_expires_at,
              tokenFingerprint: inspected.row.token_fingerprint,
              tokenGeneration: inspected.row.token_generation,
            },
            session: inspected.session,
          };
        },
        migrateToExpiringToken: (params) =>
          buildOfficialShopifyApi().auth.migrateToExpiringToken(params),
        storeSession: (session) => sessionStorage.storeSession(session),
        acquireLock: async () => {
          const now = new Date();
          const acquiredAt = now.toISOString();
          const leaseUntil = new Date(
            now.getTime() + 10 * 60_000,
          ).toISOString();
          const result = await db
            .prepare(
              `INSERT INTO ${LOCK_TABLE} (lock_id, owner_id, acquired_at, lease_until)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(lock_id) DO UPDATE SET
               owner_id = excluded.owner_id,
               acquired_at = excluded.acquired_at,
               lease_until = excluded.lease_until
             WHERE ${LOCK_TABLE}.lease_until <= ?`,
            )
            .bind(
              AUTH2B_CANARY_SHOP,
              ownerId,
              acquiredAt,
              leaseUntil,
              acquiredAt,
            )
            .run();
          return result.meta.changes === 1;
        },
        releaseLock: async () => {
          await db
            .prepare(
              `DELETE FROM ${LOCK_TABLE} WHERE lock_id = ? AND owner_id = ?`,
            )
            .bind(AUTH2B_CANARY_SHOP, ownerId)
            .run();
        },
      },
      { execute },
    );

    return json(result, { status: statusFor(result) });
  } catch {
    return json(
      { type: "auth2b_canary_rejected", error: "operator_path_failed" },
      { status: 500 },
    );
  }
};
