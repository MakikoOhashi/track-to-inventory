/**
 * Stage L5.3 — read-only Redis vs D1 usage/plan compare (production).
 *   npx tsx --env-file=.env.local scripts/usage-l53-compare.mts
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "@upstash/redis";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOP = process.argv.find((a) => a.startsWith("--shop="))?.slice(7) ||
  "luckywifi-0.myshopify.com";

function utcMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function sqlString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function d1Execute(sql: string): Array<Record<string, unknown>> {
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "track-to-inventory", "--remote", "--command", sql, "--json"],
    { encoding: "utf8", cwd: webRoot },
  );
  if (result.status !== 0) {
    throw new Error(`d1 failed: ${(result.stderr || result.stdout || "").slice(0, 200)}`);
  }
  const parsed = JSON.parse(result.stdout) as Array<{ results?: Array<Record<string, unknown>> }>;
  return parsed[0]?.results ?? [];
}

async function main() {
  const month = utcMonth();
  const redis = new Redis({
    url: requireEnv("UPSTASH_REDIS_REST_URL"),
    token: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  });

  const kinds = ["ocr", "ai", "delete"] as const;
  const rows: Array<Record<string, unknown>> = [];
  let mismatches = 0;

  for (const kind of kinds) {
    const preferred = await redis.get<string | number | null>(`tti:${kind}:${SHOP}:${month}`);
    const raw =
      preferred != null
        ? preferred
        : await redis.get<string | number | null>(`${kind}:${SHOP}:${month}`);
    const redisCount = Math.max(0, Math.floor(Number(raw ?? 0) || 0));
    const d1rows = d1Execute(
      `SELECT COUNT(*) AS c FROM usage_operations WHERE shop_id=${sqlString(SHOP)} AND kind=${sqlString(kind)} AND period_ym=${sqlString(month)} AND status='reserved'`,
    );
    const d1Count = Number(d1rows[0]?.c ?? 0);
    const match = redisCount === d1Count;
    if (!match) mismatches++;
    rows.push({ kind, redis: redisCount, d1: d1Count, match });
  }

  const redisPlanRaw =
    (await redis.get<string | null>(`tti:plan:${SHOP}`)) ??
    (await redis.get<string | null>(`plan:${SHOP}`));
  const redisPlan = String(redisPlanRaw || "free").toLowerCase();
  const d1PlanRows = d1Execute(
    `SELECT plan, source FROM shop_plans WHERE shop_id=${sqlString(SHOP)}`,
  );
  const d1Plan = d1PlanRows[0] ? String(d1PlanRows[0].plan) : null;
  const planMatch = redisPlan === d1Plan;
  if (!planMatch) mismatches++;

  const out = {
    type: "usage_l53_compare",
    shop: SHOP,
    period_ym: month,
    usage: rows,
    plan: { redis: redisPlan, d1: d1Plan, match: planMatch },
    summary: { mismatches, consistent: mismatches === 0 },
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
