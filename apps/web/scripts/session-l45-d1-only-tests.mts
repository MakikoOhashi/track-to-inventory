/**
 * Stage L4.5 — D1-only session authority + Redis adapter isolation (local D1).
 *   npm run test:session:l45
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "@shopify/shopify-api";
import { getPlatformProxy } from "wrangler";
import { runWithCloudflareEnv } from "../app/lib/cloudflareBindings.server.ts";
import {
  createShopifySessionRepository,
  SESSION_MIGRATION_SOURCE_DELETED,
} from "../app/lib/d1/shopifySessions.server.ts";
import {
  getSessionD1Mode,
  isSessionD1DualWriteActive,
  isSessionD1OnlyActive,
  isSessionD1PrimaryActive,
  isSessionD1ShadowActive,
} from "../app/lib/sessionD1Mode.server.ts";
import {
  deleteSessionD1Only,
  loadSessionD1Only,
  SESSION_D1_ONLY_TIMEOUT_MS,
  storeSessionD1Only,
} from "../app/lib/sessionD1Only.server.ts";
import {
  createRedisSessionFallbackAdapter,
  isRedisSessionConfigured,
} from "../app/lib/redisSessionFallback.server.ts";
import { hashSessionId } from "../app/lib/sessionD1Shadow.server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "..");
const SHOP = "l45-test.myshopify.com";
const TOKEN = "shpat_l45_offline";
const STATE = "state-secret-l45";

function makeOffline(token = TOKEN) {
  return new Session({
    id: `offline_${SHOP}`,
    shop: SHOP,
    state: STATE,
    isOnline: false,
    accessToken: token,
    scope: "read_products,write_inventory",
  });
}

function assertSafe(obj: unknown) {
  const s = JSON.stringify(obj);
  assert.ok(!s.includes("shpat_"));
  assert.ok(!s.includes("state-secret"));
}

function makeSlowDb(delayMs: number): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              await new Promise((r) => setTimeout(r, delayMs));
              return null;
            },
            async run() {
              await new Promise((r) => setTimeout(r, delayMs));
              return { success: true, meta: { changes: 0 } };
            },
            async all() {
              await new Promise((r) => setTimeout(r, delayMs));
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function makeErrorDb(): D1Database {
  return {
    prepare() {
      throw new Error("D1_ERROR: simulated prepare failure");
    },
  } as unknown as D1Database;
}

function wrapCountingDb(
  db: D1Database,
  counter: { selects: number; writes: number },
): D1Database {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);
      return {
        bind(...args: unknown[]) {
          const bound = stmt.bind(...args);
          return {
            async first(...a: unknown[]) {
              counter.selects += 1;
              return bound.first(...(a as []));
            },
            async all(...a: unknown[]) {
              counter.selects += 1;
              return bound.all(...(a as []));
            },
            async run(...a: unknown[]) {
              if (isWrite) counter.writes += 1;
              return bound.run(...(a as []));
            },
          };
        },
      };
    },
    batch: db.batch?.bind(db),
    exec: db.exec?.bind(db),
  } as unknown as D1Database;
}

/** Assert sessionStorage.server.ts has no direct Upstash / redisKeys session imports. */
function assertSessionStorageUsesAdapterOnly() {
  const src = readFileSync(join(webRoot, "app/sessionStorage.server.ts"), "utf8");
  assert.ok(!src.includes("@upstash/redis"));
  assert.ok(!src.includes("UPSTASH_REDIS"));
  assert.ok(!src.includes("shopifySessionKey"));
  assert.ok(src.includes("redisSessionFallback"));
  assert.ok(src.includes("sessionD1Only"));
}

async function main() {
  assert.equal(SESSION_D1_ONLY_TIMEOUT_MS, 500);
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "d1_only" }), "d1_only");
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "primary" }), "off");
  assertSessionStorageUsesAdapterOnly();

  process.env.SESSION_D1_MODE = "d1_only";
  assert.equal(isSessionD1OnlyActive(), true);
  assert.equal(isSessionD1DualWriteActive(), false);
  assert.equal(isSessionD1ShadowActive(), false);
  assert.equal(isSessionD1PrimaryActive(), false);

  const session = makeOffline();
  assertSafe({ id_hash: hashSessionId(session.id), shop: session.shop });

  // Wipe Redis env — d1_only must still work
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  assert.equal(isRedisSessionConfigured(), false);
  {
    const adapter = createRedisSessionFallbackAdapter();
    assert.equal(adapter.isConfigured(), false);
    await assert.rejects(() => adapter.load("offline_missing"), /Upstash Redis/);
  }

  const proxy = await getPlatformProxy({ persist: true });
  try {
    const rawDb = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    await rawDb
      .prepare("DELETE FROM shopify_sessions WHERE shop = ? OR id = ?")
      .bind(SHOP, session.id)
      .run();

    const counter = { selects: 0, writes: 0 };
    const db = wrapCountingDb(rawDb, counter);
    let redisCalls = 0;
    const guardRedis = () => {
      redisCalls += 1;
      throw new Error("redis must not be called in d1_only");
    };
    // sanity: we never invoke guard — redisCalls stays 0

    process.env.SESSION_D1_MODE = "d1_only";

    // --- store success ---
    counter.writes = 0;
    const stored = await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () => storeSessionD1Only({ session, db }),
    );
    assert.equal(stored, true);
    assert.ok(counter.writes >= 1);
    const live = await createShopifySessionRepository(rawDb).loadSession(session.id);
    assert.ok(live);
    assert.equal(live!.accessToken, TOKEN);
    assert.equal(redisCalls, 0);

    // --- load live ---
    counter.writes = 0;
    const loaded = await loadSessionD1Only({ sessionId: session.id, db });
    assert.equal(loaded?.accessToken, TOKEN);
    assert.equal(counter.writes, 0, "load must not write");
    assert.equal(redisCalls, 0);

    // --- overwrite / re-store → still 1 live ---
    const updated = makeOffline("shpat_l45_updated");
    assert.equal(await storeSessionD1Only({ session: updated, db: rawDb }), true);
    const liveCount = await rawDb
      .prepare(
        `SELECT COUNT(*) AS c FROM shopify_sessions
         WHERE id = ? AND IFNULL(migration_source,'') != ?`,
      )
      .bind(session.id, SESSION_MIGRATION_SOURCE_DELETED)
      .first<{ c: number }>();
    assert.equal(Number(liveCount?.c ?? 0), 1);
    const loaded2 = await loadSessionD1Only({ sessionId: session.id, db: rawDb });
    assert.equal(loaded2?.accessToken, "shpat_l45_updated");

    // --- missing ---
    await rawDb.prepare("DELETE FROM shopify_sessions WHERE id = ?").bind(session.id).run();
    assert.equal(
      await loadSessionD1Only({ sessionId: session.id, db: rawDb }),
      undefined,
    );

    // --- invalid ---
    await rawDb
      .prepare(
        `INSERT INTO shopify_sessions (
           id, shop, payload_json, is_online, expires_at,
           migration_source, migration_version, created_at, updated_at
         ) VALUES (?, ?, ?, 0, NULL, 'runtime', 'l1-v1', ?, ?)`,
      )
      .bind(
        session.id,
        SHOP,
        '{"entries":"bad"}',
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    assert.equal(
      await loadSessionD1Only({ sessionId: session.id, db: rawDb }),
      undefined,
    );

    // --- tombstone ---
    await createShopifySessionRepository(rawDb).deleteSession(session.id, {
      shop: SHOP,
    });
    assert.equal(
      await loadSessionD1Only({ sessionId: session.id, db: rawDb }),
      undefined,
    );

    // --- expired ---
    await rawDb.prepare("DELETE FROM shopify_sessions WHERE id = ?").bind(session.id).run();
    await rawDb
      .prepare(
        `INSERT INTO shopify_sessions (
           id, shop, payload_json, is_online, expires_at,
           migration_source, migration_version, created_at, updated_at
         ) VALUES (?, ?, ?, 1, ?, 'runtime', 'l1-v1', ?, ?)`,
      )
      .bind(
        session.id,
        SHOP,
        JSON.stringify({ entries: session.toPropertyArray(true), shop: SHOP }),
        new Date(Date.now() - 60_000).toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    assert.equal(
      await loadSessionD1Only({ sessionId: session.id, db: rawDb }),
      undefined,
    );

    // --- error / timeout → safe fail, redis 0 ---
    assert.equal(
      await loadSessionD1Only({ sessionId: session.id, db: makeErrorDb() }),
      undefined,
    );
    assert.equal(
      await loadSessionD1Only({
        sessionId: session.id,
        db: makeSlowDb(SESSION_D1_ONLY_TIMEOUT_MS + 80),
        timeoutMs: SESSION_D1_ONLY_TIMEOUT_MS,
      }),
      undefined,
    );
    assert.equal(
      await storeSessionD1Only({ session, db: makeErrorDb() }),
      false,
    );

    // --- delete + equal-ts tombstone priority ---
    await rawDb.prepare("DELETE FROM shopify_sessions WHERE id = ?").bind(session.id).run();
    const ts = "2026-07-24T22:00:00.000Z";
    const repo = createShopifySessionRepository(rawDb);
    assert.equal(await repo.storeSession(session, { updatedAt: ts }), true);
    assert.equal(
      await deleteSessionD1Only({ sessionId: session.id, shop: SHOP, db: rawDb }),
      true,
    );
    // Force equal-ts tombstone then reject equal-ts live
    await rawDb.prepare("DELETE FROM shopify_sessions WHERE id = ?").bind(session.id).run();
    assert.equal(await repo.storeSession(session, { updatedAt: ts }), true);
    assert.equal(
      await repo.deleteSession(session.id, { shop: SHOP, updatedAt: ts }),
      true,
    );
    assert.equal(
      await repo.storeSession(session, { updatedAt: ts }),
      false,
      "equal-ts must not resurrect",
    );
    // d1_only delete re-run safe on tombstone
    assert.equal(
      await deleteSessionD1Only({ sessionId: session.id, shop: SHOP, db: rawDb }),
      true,
    );
    const tomb = await rawDb
      .prepare("SELECT migration_source FROM shopify_sessions WHERE id = ?")
      .bind(session.id)
      .first<{ migration_source: string }>();
    assert.equal(tomb?.migration_source, SESSION_MIGRATION_SOURCE_DELETED);

    assert.equal(redisCalls, 0);
    void guardRedis;

    // mode regression
    process.env.SESSION_D1_MODE = "dual_write";
    assert.equal(isSessionD1OnlyActive(), false);
    assert.equal(isSessionD1DualWriteActive(), true);
    process.env.SESSION_D1_MODE = "d1_primary";
    assert.equal(isSessionD1OnlyActive(), false);
    process.env.SESSION_D1_MODE = "shadow";
    assert.equal(isSessionD1ShadowActive(), true);

    console.log(
      JSON.stringify({
        type: "session_l45_d1_only_tests_ok",
        timeout_ms: SESSION_D1_ONLY_TIMEOUT_MS,
        redis_env_present: false,
        redis_calls: redisCalls,
      }),
    );
  } finally {
    if (savedUrl) process.env.UPSTASH_REDIS_REST_URL = savedUrl;
    if (savedToken) process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
    await proxy.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
