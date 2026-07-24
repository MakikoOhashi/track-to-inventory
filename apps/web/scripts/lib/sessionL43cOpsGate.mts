/**
 * Shared L4.3c ops gate helpers (read-only identity checks).
 * Not imported by the Worker.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Session } from "@shopify/shopify-api";
import {
  SESSION_MIGRATION_SOURCE_DELETED,
} from "../../app/lib/d1/shopifySessions.server.ts";
import { hashSessionId } from "../../app/lib/sessionD1Shadow.server.ts";

export const L43C_TARGET_HASH = "34c1ff3514f08d08";
export const L43C_TARGET_SHOP = "luckywifi-0.myshopify.com";
export const L43C_OPS_CONFIG = "wrangler.ops-l43c.jsonc";
export const L43C_MAIN_CONFIG = "wrangler.jsonc";

export type StoredSessionPayload = {
  entries: [string, string | number | boolean][];
  shop: string;
  expiresAt?: number;
};

export type SessionSnap = {
  table_exists: boolean;
  live_count: number;
  dup_count: number;
  target_rows: number;
  migration_source: string | null;
  updated_at: string | null;
  expires_at: string | null;
  is_online: number | null;
  fingerprint: string | null;
  ledger_succeeded: number;
};

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function fingerprint(session: Session): string {
  const entries = session
    .toPropertyArray(true)
    .map(([k, v]) => [String(k), v] as [string, string | number | boolean])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex")
    .slice(0, 16);
}

export function assertSafe(obj: unknown): void {
  const s = JSON.stringify(obj);
  if (/shpat_|state-secret|eyJhbGci/i.test(s)) {
    throw new Error("secret leakage in output");
  }
}

/** Strip block / line comments so JSON.parse works on jsonc. */
export function parseJsoncFile(path: string): Record<string, unknown> {
  const raw = readFileSync(path, "utf8");
  const noBlocks = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const stripped = noBlocks
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx === -1) return line;
      const before = line.slice(0, idx);
      if ((before.match(/"/g) || []).length % 2 === 0) return before;
      return line;
    })
    .join("\n");
  return JSON.parse(stripped) as Record<string, unknown>;
}

export function readD1Binding(configPath: string): {
  binding: string;
  database_name: string;
  database_id: string;
  remote: boolean;
} {
  const cfg = parseJsoncFile(configPath);
  const d1 = cfg.d1_databases as Array<Record<string, unknown>> | undefined;
  const row = d1?.[0];
  if (!row) throw new Error(`no d1_databases in ${configPath}`);
  return {
    binding: String(row.binding ?? ""),
    database_name: String(row.database_name ?? ""),
    database_id: String(row.database_id ?? ""),
    remote: row.remote === true,
  };
}

export function assertOpsConfigMatchesMain(webRoot: string): {
  ops: ReturnType<typeof readD1Binding>;
  main: ReturnType<typeof readD1Binding>;
} {
  const main = readD1Binding(join(webRoot, L43C_MAIN_CONFIG));
  const ops = readD1Binding(join(webRoot, L43C_OPS_CONFIG));
  if (ops.binding !== main.binding || ops.binding !== "TTI_DB") {
    throw new Error("ops binding must be TTI_DB matching main");
  }
  if (ops.database_name !== main.database_name) {
    throw new Error("ops database_name must match main production config");
  }
  if (ops.database_id !== main.database_id) {
    throw new Error("ops database_id must match main production config");
  }
  if (!ops.remote) {
    throw new Error("ops config must set d1_databases[].remote=true");
  }
  if (main.remote) {
    throw new Error("main wrangler.jsonc must NOT set remote=true (ops isolation)");
  }
  return { ops, main };
}

export async function snapFromDb(db: D1Database): Promise<SessionSnap> {
  const table = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM sqlite_master
       WHERE type='table' AND name='shopify_sessions'`,
    )
    .first<{ c: number }>();
  const tableExists = Number(table?.c ?? 0) > 0;
  if (!tableExists) {
    return {
      table_exists: false,
      live_count: -1,
      dup_count: -1,
      target_rows: -1,
      migration_source: null,
      updated_at: null,
      expires_at: null,
      is_online: null,
      fingerprint: null,
      ledger_succeeded: -1,
    };
  }

  const live = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM shopify_sessions
       WHERE IFNULL(migration_source, '') != ?`,
    )
    .bind(SESSION_MIGRATION_SOURCE_DELETED)
    .first<{ c: number }>();

  const dup = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT id FROM shopify_sessions GROUP BY id HAVING COUNT(*) > 1
       )`,
    )
    .first<{ c: number }>();

  const target = await db
    .prepare(
      `SELECT payload_json, migration_source, updated_at, expires_at, is_online
       FROM shopify_sessions
       WHERE shop = ?
         AND IFNULL(migration_source, '') != ?`,
    )
    .bind(L43C_TARGET_SHOP, SESSION_MIGRATION_SOURCE_DELETED)
    .all<{
      payload_json: string;
      migration_source: string | null;
      updated_at: string;
      expires_at: string | null;
      is_online: number;
    }>();

  const rows = target.results ?? [];
  let fp: string | null = null;
  let migration_source: string | null = null;
  let updated_at: string | null = null;
  let expires_at: string | null = null;
  let is_online: number | null = null;
  if (rows.length === 1) {
    const row = rows[0];
    const payload = JSON.parse(row.payload_json);
    const session = Session.fromPropertyArray(payload.entries, true);
    if (hashSessionId(session.id) !== L43C_TARGET_HASH) {
      throw new Error("target shop row hash mismatch");
    }
    fp = fingerprint(session);
    migration_source = row.migration_source;
    updated_at = row.updated_at;
    expires_at = row.expires_at;
    is_online = Number(row.is_online);
  }

  const ledger = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM inventory_sync_ledger WHERE status='succeeded'`,
    )
    .first<{ c: number }>();

  return {
    table_exists: true,
    live_count: Number(live?.c ?? -1),
    dup_count: Number(dup?.c ?? -1),
    target_rows: rows.length,
    migration_source,
    updated_at,
    expires_at,
    is_online,
    fingerprint: fp,
    ledger_succeeded: Number(ledger?.c ?? -1),
  };
}

export function compareSnaps(
  proxy: SessionSnap,
  remote: SessionSnap,
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const keys: (keyof SessionSnap)[] = [
    "table_exists",
    "live_count",
    "dup_count",
    "target_rows",
    "migration_source",
    "updated_at",
    "expires_at",
    "is_online",
    "fingerprint",
    "ledger_succeeded",
  ];
  for (const k of keys) {
    if (String(proxy[k]) !== String(remote[k])) {
      mismatches.push(k);
    }
  }
  if (!proxy.table_exists) mismatches.push("proxy_missing_table");
  if (proxy.live_count < 1) mismatches.push("proxy_empty_live");
  if (proxy.target_rows !== 1) mismatches.push("proxy_target_rows");
  if (proxy.dup_count !== 0) mismatches.push("proxy_dups");
  return { ok: mismatches.length === 0, mismatches: [...new Set(mismatches)] };
}
