/**
 * Dual-read helpers: prefer tti: keys, fall back to legacy once.
 * New writes always target the tti: key. Hydrate-from-legacy before INCR.
 */
import type { Redis } from "@upstash/redis";

export async function getStringPreferNew(
  redis: Redis,
  newKey: string,
  legacyKey: string,
): Promise<string | null> {
  const neu = await redis.get<string>(newKey);
  if (neu != null) return neu;
  const old = await redis.get<string>(legacyKey);
  return old ?? null;
}

export async function getJsonPreferNew<T>(
  redis: Redis,
  newKey: string,
  legacyKey: string,
): Promise<T | null> {
  const neu = (await redis.get(newKey)) as T | null;
  if (neu != null) return neu;
  return ((await redis.get(legacyKey)) as T | null) ?? null;
}

export async function hgetallPreferNew(
  redis: Redis,
  newKey: string,
  legacyKey: string,
): Promise<Record<string, string> | null> {
  const neu = (await redis.hgetall(newKey)) as Record<string, string> | null;
  if (neu && Object.keys(neu).length > 0) return neu;
  const old = (await redis.hgetall(legacyKey)) as Record<string, string> | null;
  if (old && Object.keys(old).length > 0) return old;
  return null;
}

export async function smembersPreferNew(
  redis: Redis,
  newKey: string,
  legacyKey: string,
): Promise<string[]> {
  const neu = (await redis.smembers(newKey)) as string[];
  if (Array.isArray(neu) && neu.length > 0) return neu;
  const old = (await redis.smembers(legacyKey)) as string[];
  return Array.isArray(old) ? old : [];
}

/** Copy legacy → new if new missing, preserving TTL; then INCR new. */
export async function incrHydrateFromLegacy(
  redis: Redis,
  newKey: string,
  legacyKey: string,
): Promise<number> {
  const exists = await redis.exists(newKey);
  if (!exists) {
    const old = await redis.get(legacyKey);
    if (old != null) {
      const ttl = await redis.ttl(legacyKey);
      if (ttl > 0) {
        await redis.set(newKey, old, { ex: ttl });
      } else {
        await redis.set(newKey, old);
      }
    }
  }
  return redis.incr(newKey);
}

export async function valuesEqual(a: unknown, b: unknown): Promise<boolean> {
  return stableStringify(a) === stableStringify(b);
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
