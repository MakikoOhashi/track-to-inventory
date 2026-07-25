/**
 * Stage L5.2 — seed current-month usage (OCR/AI/delete) + plan from Redis/Shopify
 * Billing into D1, then reconcile. Prepares the D1 usage/plan path for a later
 * cut-over. Existing production routes keep reading/writing Redis.
 *
 *   npx tsx --env-file=.env.local scripts/usage-l52-seed-reconcile.mts --dry-run --remote
 *   npx tsx --env-file=.env.local scripts/usage-l52-seed-reconcile.mts --apply --remote
 *
 * Guarantees:
 * - Redis: SCAN/GET only. Never SET/DEL. No Redis mutation.
 * - Shopify Billing: read-only activeSubscriptions query (no mutation).
 * - D1: idempotent. Usage is seeded as deterministic synthetic operation rows
 *   (operation_id = "seed:l52:{kind}:{period}:{shopHash}:{i}") with
 *   ON CONFLICT DO NOTHING, so re-running never inflates counts.
 * - No Worker deploy, no env change, no session-mode change.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "@upstash/redis";
import { Session } from "@shopify/shopify-api";

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;
const REMOTE = process.argv.includes("--remote");
const targetFlag = REMOTE ? "--remote" : "--local";
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SEED_SOURCE = "seed_l52";
const SEED_MIGRATION_VERSION = "l5.2";
const BILLING_API_VERSION = "2024-01";
type Kind = "ocr" | "ai" | "delete";
const KINDS: Kind[] = ["ocr", "ai", "delete"];
type UserPlan = "free" | "basic" | "pro";

const PLAN_NAME_MAP: Record<string, UserPlan> = {
  "Basic Plan": "basic",
  "Pro Plan": "pro",
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** UTC calendar month YYYY-MM — matches D1 utcPeriodYm + Cloudflare(UTC) Redis keys. */
function utcMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shopHash(shop: string): string {
  return createHash("sha256").update(shop).digest("hex").slice(0, 16);
}

function sqlString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function d1Execute(sql: string): Array<Record<string, unknown>> {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "track-to-inventory",
      targetFlag,
      "--command",
      sql,
      "--json",
    ],
    { encoding: "utf8", cwd: webRoot },
  );
  if (result.status !== 0) {
    const err = `${result.stderr || result.stdout || ""}`.slice(0, 300);
    throw new Error(
      `d1 execute failed (${targetFlag}): ${err.replace(/shpat_[^\s'"]+/g, "<redacted>")}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as Array<{
    results?: Array<Record<string, unknown>>;
  }>;
  return parsed[0]?.results ?? [];
}

async function scanKeys(redis: Redis, match: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = 0;
  do {
    const [next, batch] = (await redis.scan(cursor, { match, count: 200 })) as [
      string | number,
      string[],
    ];
    cursor = Number(next);
    keys.push(...(batch || []));
  } while (cursor !== 0);
  return [...new Set(keys)];
}

/**
 * Effective current-month Redis count for (shop, kind), mirroring
 * getStringPreferNew: prefer tti: key, fall back to legacy.
 */
async function effectiveRedisCount(
  redis: Redis,
  shop: string,
  kind: Kind,
  month: string,
): Promise<number> {
  const newKey = `tti:${kind}:${shop}:${month}`;
  const legacyKey = `${kind}:${shop}:${month}`;
  const preferred = await redis.get<string | number | null>(newKey);
  const raw =
    preferred != null
      ? preferred
      : await redis.get<string | number | null>(legacyKey);
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Discover shops + counts for the given month from both new and legacy usage
 * keys. Returns map shop -> { kind -> effectiveCount }.
 */
async function readRedisUsage(
  redis: Redis,
  month: string,
): Promise<Map<string, Record<Kind, number>>> {
  const shops = new Set<string>();
  for (const kind of KINDS) {
    for (const pattern of [`tti:${kind}:*:${month}`, `${kind}:*:${month}`]) {
      const keys = await scanKeys(redis, pattern);
      for (const key of keys) {
        // strip optional tti: prefix, then "{kind}:", then trailing ":{month}"
        let k = key.startsWith("tti:") ? key.slice(4) : key;
        if (!k.startsWith(`${kind}:`)) continue;
        k = k.slice(kind.length + 1);
        if (!k.endsWith(`:${month}`)) continue;
        const shop = k.slice(0, k.length - (month.length + 1));
        if (shop) shops.add(shop);
      }
    }
  }

  const out = new Map<string, Record<Kind, number>>();
  for (const shop of shops) {
    const counts = {} as Record<Kind, number>;
    for (const kind of KINDS) {
      counts[kind] = await effectiveRedisCount(redis, shop, kind, month);
    }
    out.set(shop, counts);
  }
  return out;
}

/** Offline access tokens per shop, read-only, from Redis session payloads. */
async function readOfflineTokens(
  redis: Redis,
): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  const keys = [
    ...(await scanKeys(redis, "tti:shopify:session:*")),
    ...(await scanKeys(redis, "shopify:session:*")).filter(
      (k) => !k.startsWith("tti:"),
    ),
  ];
  for (const key of keys) {
    const payload = (await redis.get(key)) as
      | { entries?: [string, string | number | boolean][] }
      | null;
    if (!payload?.entries) continue;
    try {
      const session = Session.fromPropertyArray(payload.entries, true);
      if (!session.isOnline && session.shop && session.accessToken) {
        tokens.set(session.shop, session.accessToken);
      }
    } catch {
      // ignore unparsable payloads
    }
  }
  return tokens;
}

/** Read-only Shopify Billing check → plan. Never mutates Shopify or Redis. */
async function planFromBilling(
  shop: string,
  accessToken: string,
): Promise<{ plan: UserPlan; source: string } | { error: string }> {
  const query = `{ currentAppInstallation { activeSubscriptions { name status } } }`;
  try {
    const res = await fetch(
      `https://${shop}/admin/api/${BILLING_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query }),
      },
    );
    if (!res.ok) return { error: `billing_http_${res.status}` };
    const body = (await res.json()) as {
      data?: {
        currentAppInstallation?: {
          activeSubscriptions?: { name: string; status: string }[];
        };
      };
    };
    const subs = body?.data?.currentAppInstallation?.activeSubscriptions;
    if (!Array.isArray(subs)) return { plan: "free", source: "shopify_billing" };
    if (subs.some((s) => PLAN_NAME_MAP[s.name] === "pro" && s.status === "ACTIVE"))
      return { plan: "pro", source: "shopify_billing" };
    if (
      subs.some((s) => PLAN_NAME_MAP[s.name] === "basic" && s.status === "ACTIVE")
    )
      return { plan: "basic", source: "shopify_billing" };
    return { plan: "free", source: "shopify_billing" };
  } catch (error) {
    return { error: `billing_error:${(error as Error).message.slice(0, 60)}` };
  }
}

async function redisPlan(redis: Redis, shop: string): Promise<UserPlan> {
  const preferred = await redis.get<string | null>(`tti:plan:${shop}`);
  const raw = preferred != null ? preferred : await redis.get<string | null>(`plan:${shop}`);
  const v = String(raw || "").trim().toLowerCase();
  return v === "basic" || v === "pro" || v === "free" ? (v as UserPlan) : "free";
}

// --- D1 idempotent writers -------------------------------------------------

function ensureShopSql(shop: string, ts: string): string {
  return `INSERT INTO shops (shop_id, installed_at, uninstalled_at, plan_cached, migration_source, migration_version, created_at, updated_at)
    VALUES (${sqlString(shop)}, ${sqlString(ts)}, NULL, NULL, ${sqlString(SEED_SOURCE)}, ${sqlString(SEED_MIGRATION_VERSION)}, ${sqlString(ts)}, ${sqlString(ts)})
    ON CONFLICT(shop_id) DO NOTHING`;
}

function seedOperationsSql(
  shop: string,
  kind: Kind,
  month: string,
  count: number,
  ts: string,
): string {
  const h = shopHash(shop);
  const rows: string[] = [];
  for (let i = 1; i <= count; i++) {
    const opId = `seed:l52:${kind}:${month}:${h}:${i}`;
    rows.push(
      `(${sqlString(opId)}, ${sqlString(shop)}, ${sqlString(kind)}, ${sqlString(month)}, 'reserved', ${sqlString(SEED_SOURCE)}, ${sqlString(SEED_MIGRATION_VERSION)}, ${sqlString(ts)}, ${sqlString(ts)})`,
    );
  }
  return `INSERT INTO usage_operations (operation_id, shop_id, kind, period_ym, status, migration_source, migration_version, created_at, updated_at)
    VALUES ${rows.join(", ")}
    ON CONFLICT(operation_id) DO NOTHING`;
}

function syncCounterSql(shop: string, kind: Kind, month: string, ts: string): string {
  return `INSERT INTO usage_counters (shop_id, kind, period_ym, count, migration_source, migration_version, created_at, updated_at)
    SELECT ${sqlString(shop)}, ${sqlString(kind)}, ${sqlString(month)},
      (SELECT COUNT(*) FROM usage_operations WHERE shop_id=${sqlString(shop)} AND kind=${sqlString(kind)} AND period_ym=${sqlString(month)} AND status='reserved'),
      ${sqlString(SEED_SOURCE)}, ${sqlString(SEED_MIGRATION_VERSION)}, ${sqlString(ts)}, ${sqlString(ts)}
    ON CONFLICT(shop_id, kind, period_ym) DO UPDATE SET
      count = excluded.count, updated_at = excluded.updated_at,
      migration_source = excluded.migration_source, migration_version = excluded.migration_version`;
}

function upsertPlanSql(shop: string, plan: UserPlan, source: string, ts: string): string {
  return `INSERT INTO shop_plans (shop_id, plan, source, migration_source, migration_version, created_at, updated_at)
    VALUES (${sqlString(shop)}, ${sqlString(plan)}, ${sqlString(source)}, ${sqlString(SEED_SOURCE)}, ${sqlString(SEED_MIGRATION_VERSION)}, ${sqlString(ts)}, ${sqlString(ts)})
    ON CONFLICT(shop_id) DO UPDATE SET
      plan = excluded.plan, source = excluded.source,
      migration_source = excluded.migration_source, migration_version = excluded.migration_version,
      updated_at = excluded.updated_at
    WHERE excluded.updated_at > shop_plans.updated_at`;
}

function d1ReservedCount(shop: string, kind: Kind, month: string): number {
  const rows = d1Execute(
    `SELECT COUNT(*) AS c FROM usage_operations WHERE shop_id=${sqlString(shop)} AND kind=${sqlString(kind)} AND period_ym=${sqlString(month)} AND status='reserved'`,
  );
  return Number(rows[0]?.c ?? 0);
}

function d1Plan(shop: string): UserPlan | null {
  const rows = d1Execute(`SELECT plan FROM shop_plans WHERE shop_id=${sqlString(shop)}`);
  if (!rows[0]) return null;
  return String(rows[0].plan) as UserPlan;
}

// --- main ------------------------------------------------------------------

async function main() {
  const mode = APPLY ? "apply" : "dry-run";
  const month = utcMonth();
  const ts = nowIso();

  const redis = new Redis({
    url: requireEnv("UPSTASH_REDIS_REST_URL"),
    token: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  });

  const usageByShop = await readRedisUsage(redis, month);
  const tokens = await readOfflineTokens(redis);

  // Shops we consider = those with usage this month ∪ those with a session token.
  const shops = new Set<string>([...usageByShop.keys(), ...tokens.keys()]);

  const usageReport: Array<Record<string, unknown>> = [];
  const planReport: Array<Record<string, unknown>> = [];

  for (const shop of shops) {
    const counts = usageByShop.get(shop) ?? { ocr: 0, ai: 0, delete: 0 };

    // ---- Plan (Shopify Billing is source of truth) ----
    let plan: UserPlan;
    let planSource: string;
    let planNote: string | undefined;
    const token = tokens.get(shop);
    if (token) {
      const billing = await planFromBilling(shop, token);
      if ("plan" in billing) {
        plan = billing.plan;
        planSource = billing.source;
      } else {
        plan = await redisPlan(redis, shop);
        planSource = "redis_fallback";
        planNote = billing.error;
      }
    } else {
      plan = await redisPlan(redis, shop);
      planSource = "redis_fallback";
      planNote = "no_offline_session_token";
    }

    if (APPLY) {
      d1Execute(ensureShopSql(shop, ts));
      d1Execute(upsertPlanSql(shop, plan, planSource, ts));
      for (const kind of KINDS) {
        if (counts[kind] > 0) {
          d1Execute(seedOperationsSql(shop, kind, month, counts[kind], ts));
        }
        d1Execute(syncCounterSql(shop, kind, month, ts));
      }
    }

    planReport.push({
      shop,
      plan,
      source: planSource,
      ...(planNote ? { note: planNote } : {}),
    });
    for (const kind of KINDS) {
      usageReport.push({ shop, kind, period_ym: month, redis: counts[kind] });
    }
  }

  // ---- Reconcile (only meaningful after apply; dry-run shows current D1) ----
  const reconcile: Array<Record<string, unknown>> = [];
  let usageDiffs = 0;
  let planDiffs = 0;
  for (const shop of shops) {
    const counts = usageByShop.get(shop) ?? { ocr: 0, ai: 0, delete: 0 };
    for (const kind of KINDS) {
      const d1c = d1ReservedCount(shop, kind, month);
      const match = d1c === counts[kind];
      if (!match) usageDiffs++;
      reconcile.push({
        shop,
        kind,
        period_ym: month,
        redis: counts[kind],
        d1: d1c,
        match,
      });
    }
    const pr = planReport.find((p) => p.shop === shop);
    const d1p = d1Plan(shop);
    const planMatch = d1p === (pr?.plan ?? null);
    if (!planMatch) planDiffs++;
    reconcile.push({
      shop,
      field: "plan",
      expected: pr?.plan ?? null,
      d1: d1p,
      match: planMatch,
    });
  }

  const out = {
    type: "usage_l52_seed_reconcile",
    mode,
    target: REMOTE ? "remote" : "local",
    period_ym: month,
    shops: shops.size,
    plan_seed: planReport,
    usage_redis: usageReport,
    reconcile,
    summary: {
      usage_mismatches: usageDiffs,
      plan_mismatches: planDiffs,
      consistent: usageDiffs === 0 && planDiffs === 0,
    },
  };

  const serialized = JSON.stringify(out, null, 2);
  if (/shpat_|UPSTASH|REST_TOKEN/.test(serialized)) {
    throw new Error("refusing to print output containing potential secrets");
  }
  console.log(serialized);

  if (DRY_RUN) {
    console.error("\n[dry-run] no D1 writes performed. Re-run with --apply to seed.");
  }
}

main().catch((error) => {
  console.error(String((error as Error)?.message ?? error).replace(/shpat_[^\s'"]+/g, "<redacted>"));
  process.exit(1);
});
