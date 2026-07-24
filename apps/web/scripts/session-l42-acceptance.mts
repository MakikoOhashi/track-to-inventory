/**
 * Stage L4.2 data-plane acceptance: Redis primary vs D1 seed (read-only).
 * Does not OAuth / mutate Shopify / write Redis or D1.
 *
 *   npx tsx --env-file=.env.local scripts/session-l42-acceptance.mts
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "@upstash/redis";
import { Session } from "@shopify/shopify-api";
import {
  classifySessionShadow,
  hashSessionId,
  snapFromSession,
} from "../app/lib/sessionD1Shadow.server.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_HASH = "34c1ff3514f08d08";
const TARGET_SHOP = "luckywifi-0.myshopify.com";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function d1Execute(sql: string): Array<Record<string, unknown>> {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "track-to-inventory",
      "--remote",
      "--command",
      sql,
      "--json",
    ],
    { encoding: "utf8", cwd: webRoot },
  );
  if (result.status !== 0) {
    throw new Error(`d1 failed: ${(result.stderr || result.stdout || "").slice(0, 200)}`);
  }
  const parsed = JSON.parse(result.stdout) as Array<{
    results?: Array<Record<string, unknown>>;
  }>;
  return parsed[0]?.results ?? [];
}

async function scan(redis: Redis, match: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = 0;
  do {
    const [next, batch] = (await redis.scan(cursor, { match, count: 100 })) as [
      string | number,
      string[],
    ];
    cursor = Number(next);
    keys.push(...(batch || []));
  } while (cursor !== 0);
  return [...new Set(keys)];
}

async function main() {
  const redis = new Redis({
    url: requireEnv("UPSTASH_REDIS_REST_URL"),
    token: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  });

  const newKeys = await scan(redis, "tti:shopify:session:*");
  const legacyKeys = (await scan(redis, "shopify:session:*")).filter(
    (k) => !k.startsWith("tti:"),
  );
  const d1Count = Number(
    d1Execute(`SELECT COUNT(*) AS c FROM shopify_sessions`)[0]?.c ?? -1,
  );
  const ledger = d1Execute(
    `SELECT COUNT(*) AS c, SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS s FROM inventory_sync_ledger`,
  )[0];

  let category = "none";
  let idHash = "";
  let shop = "";

  if (newKeys.length === 1) {
    const id = newKeys[0].slice("tti:shopify:session:".length);
    idHash = hashSessionId(id);
    const payload = (await redis.get(newKeys[0])) as {
      entries: [string, string | number | boolean][];
      shop: string;
    };
    const redisSession = Session.fromPropertyArray(payload.entries, true);
    shop = redisSession.shop;

    const rows = d1Execute(
      `SELECT payload_json FROM shopify_sessions WHERE shop = ${sqlString(TARGET_SHOP)}`,
    );
    if (rows.length === 0) {
      category = "missing_in_d1";
    } else {
      const d1Payload = JSON.parse(String(rows[0].payload_json));
      const d1Session = Session.fromPropertyArray(d1Payload.entries, true);
      category = classifySessionShadow(
        snapFromSession(redisSession),
        snapFromSession(d1Session),
      );
    }
  }

  const out = {
    type: "session_l42_acceptance",
    redis_tti_sessions: newKeys.length,
    redis_legacy_sessions: legacyKeys.length,
    d1_sessions: d1Count,
    target_hash_ok: idHash === TARGET_HASH,
    shop,
    session_id_hash: idHash,
    compare_category: category,
    returned_source: "redis",
    d1_write: 0,
    redis_write: 0,
    inventory_mutation: 0,
    ledger_count: Number(ledger?.c ?? -1),
    ledger_succeeded: Number(ledger?.s ?? -1),
    d1_ledger_mode_expected: "shadow",
    worker_path_observed: false,
    note: "Data-plane compare only; Worker log match requires a live authenticated loadSession",
  };

  const s = JSON.stringify(out);
  if (/shpat_|\"state\":\"[^"]{4,}\"/i.test(s)) {
    throw new Error("secret leakage");
  }
  console.log(JSON.stringify(out, null, 2));

  if (category !== "match" || d1Count !== 1 || newKeys.length !== 1) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
