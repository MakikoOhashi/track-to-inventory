/**
 * Migrate TTI Redis keys into tti: namespace (Stage K3.6).
 *
 * Usage (apps/web, with .env.local loaded):
 *   node --experimental-strip-types scripts/migrate-tti-namespace.mts --dry-run
 *   node --experimental-strip-types scripts/migrate-tti-namespace.mts --apply
 *
 * Does NOT delete old keys. Does NOT touch ruidaichan:* / wakarumade:* / tti-*.
 */
import { Redis } from "@upstash/redis";

const DRY_RUN = process.argv.includes("--dry-run") || !process.argv.includes("--apply");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function mask(key: string): string {
  return key
    .replace(/[a-z0-9][a-z0-9-]*\.myshopify\.com/gi, "<shop>")
    .replace(/Sk[0-9A-Za-z-]+/g, "<si>")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<uuid>",
    )
    .replace(/[0-9a-f]{32,}/gi, "<hex>");
}

function mapLegacyToNew(legacyKey: string): string | null {
  if (legacyKey.startsWith("tti:")) return null;
  const prefixes = [
    "invsync:ledger:",
    "invsync:si:",
    "notion:connection:",
    "notion:oauth-state:",
    "notion:provision-lock:",
    "shopify:session:",
    "shopify:shop-sessions:",
    "plan:",
    "ai:",
    "ocr:",
    "delete:",
  ];
  if (!prefixes.some((p) => legacyKey.startsWith(p))) return null;
  return `tti:${legacyKey}`;
}

function isOtherApp(key: string): boolean {
  return (
    key.startsWith("ruidaichan:") ||
    key.startsWith("wakarumade:") ||
    key.startsWith("tti-")
  );
}

function stableStringify(value: unknown): string {
  if (value == null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

async function readValue(
  redis: Redis,
  key: string,
  type: string,
): Promise<unknown> {
  if (type === "string") return redis.get(key);
  if (type === "hash") return redis.hgetall(key);
  if (type === "set") {
    const members = (await redis.smembers(key)) as string[];
    return [...members].sort();
  }
  if (type === "list") return redis.lrange(key, 0, -1);
  if (type === "zset") return redis.zrange(key, 0, -1, { withScores: true });
  throw new Error(`Unsupported type ${type} for ${mask(key)}`);
}

async function writeValue(
  redis: Redis,
  key: string,
  type: string,
  value: unknown,
  ttl: number,
): Promise<void> {
  if (type === "string") {
    if (ttl > 0) await redis.set(key, value as string | number, { ex: ttl });
    else await redis.set(key, value as string | number);
    return;
  }
  if (type === "hash") {
    const hash = value as Record<string, unknown>;
    if (!hash || Object.keys(hash).length === 0) return;
    await redis.hset(key, hash);
    if (ttl > 0) await redis.expire(key, ttl);
    return;
  }
  if (type === "set") {
    let members = value as string[];
    // Remap invsync ledger members inside SI index sets
    if (key.startsWith("tti:invsync:si:")) {
      members = members.map((m) =>
        m.startsWith("invsync:ledger:") ? `tti:${m}` : m,
      );
    }
    if (members.length === 0) return;
    await redis.sadd(key, ...members);
    if (ttl > 0) await redis.expire(key, ttl);
    return;
  }
  throw new Error(`Unsupported write type ${type}`);
}

async function main() {
  const redis = new Redis({
    url: requireEnv("UPSTASH_REDIS_REST_URL"),
    token: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  });

  const all = (await redis.keys("*")) as string[];
  const otherApp = all.filter(isOtherApp);
  const candidates = all
    .map((k) => ({ legacy: k, neu: mapLegacyToNew(k) }))
    .filter((x): x is { legacy: string; neu: string } => Boolean(x.neu));

  const plan = [];
  for (const { legacy, neu } of candidates) {
    const type = await redis.type(legacy);
    const ttl = await redis.ttl(legacy);
    plan.push({ legacy, neu, type, ttl });
  }

  console.log(
    JSON.stringify(
      {
        mode: DRY_RUN ? "dry-run" : "apply",
        totalKeys: all.length,
        otherAppUntouched: otherApp.length,
        ttiCandidates: plan.length,
        mapping: plan.map((p) => ({
          from: mask(p.legacy),
          to: mask(p.neu),
          type: p.type,
          ttl: p.ttl,
        })),
      },
      null,
      2,
    ),
  );

  const results = {
    inserted: 0,
    skipped_identical: 0,
    conflict: 0,
    conflicts: [] as Array<{ from: string; to: string; type: string }>,
  };

  for (const item of plan) {
    const oldVal = await readValue(redis, item.legacy, item.type);
    const newExists = await redis.exists(item.neu);

    if (newExists) {
      const newType = await redis.type(item.neu);
      if (newType !== item.type) {
        results.conflict += 1;
        results.conflicts.push({
          from: mask(item.legacy),
          to: mask(item.neu),
          type: `type ${item.type} vs ${newType}`,
        });
        continue;
      }
      let newVal = await readValue(redis, item.neu, item.type);
      // Compare SI sets with remapped legacy members
      let compareOld = oldVal;
      if (item.type === "set" && item.neu.startsWith("tti:invsync:si:")) {
        compareOld = (oldVal as string[]).map((m) =>
          m.startsWith("invsync:ledger:") ? `tti:${m}` : m,
        );
        compareOld = [...(compareOld as string[])].sort();
        newVal = [...(newVal as string[])].sort();
      }
      if (stableStringify(compareOld) === stableStringify(newVal)) {
        results.skipped_identical += 1;
        continue;
      }
      results.conflict += 1;
      results.conflicts.push({
        from: mask(item.legacy),
        to: mask(item.neu),
        type: "content mismatch",
      });
      continue;
    }

    if (DRY_RUN) {
      results.inserted += 1;
      continue;
    }

    await writeValue(redis, item.neu, item.type, oldVal, item.ttl);
    results.inserted += 1;
  }

  if (results.conflict > 0) {
    console.error(JSON.stringify({ error: "CONFLICT", results }, null, 2));
    process.exit(2);
  }

  // Post-check: ledger hashes + SI index
  const ledgerLegacy = all.filter((k) => k.startsWith("invsync:ledger:"));
  const ledgerNew = ((await redis.keys("tti:invsync:ledger:*")) as string[]) || [];
  const siLegacy = all.filter((k) => k.startsWith("invsync:si:"));
  const siNew = ((await redis.keys("tti:invsync:si:*")) as string[]) || [];

  let succeededNew = 0;
  if (!DRY_RUN) {
    for (const k of ledgerNew) {
      const st = await redis.hget(k, "status");
      if (st === "succeeded") succeededNew += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: DRY_RUN ? "dry-run" : "apply",
        results,
        postCheck: DRY_RUN
          ? null
          : {
              ledgerLegacy: ledgerLegacy.length,
              ledgerNew: ledgerNew.length,
              siLegacy: siLegacy.length,
              siNew: siNew.length,
              succeededNew,
              otherAppStillPresent: otherApp.length,
            },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
