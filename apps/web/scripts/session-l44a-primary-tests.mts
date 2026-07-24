/**
 * Stage L4.4a — D1 primary read + Redis fallback (local D1).
 *   npm run test:session:l44a
 */
import assert from "node:assert/strict";
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
  isSessionD1PrimaryActive,
  isSessionD1ShadowActive,
} from "../app/lib/sessionD1Mode.server.ts";
import {
  loadSessionD1Primary,
  SESSION_D1_PRIMARY_TIMEOUT_MS,
} from "../app/lib/sessionD1Primary.server.ts";
import {
  mirrorSessionDeleteToD1,
  mirrorSessionStoreToD1,
} from "../app/lib/sessionD1DualWrite.server.ts";
import { l44bHardGateIds, L44B_ROLLBACK_MODE } from "../app/lib/sessionL44bGate.server.ts";
import { hashSessionId } from "../app/lib/sessionD1Shadow.server.ts";

const SHOP = "l44a-test.myshopify.com";
const TOKEN = "shpat_l44a_offline";
const STATE = "state-secret-l44a";

function makeOffline(shop = SHOP, token = TOKEN) {
  return new Session({
    id: `offline_${shop}`,
    shop,
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
  assert.ok(!/eyJhbGci/i.test(s));
}

function makeRedisLoader(session: Session | undefined, counter: { n: number }) {
  return async () => {
    counter.n += 1;
    return {
      session,
      namespace: session ? ("tti" as const) : ("miss" as const),
    };
  };
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

function wrapWriteCountingDb(db: D1Database, counter: { writes: number }): D1Database {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          const bound = stmt.bind(...args);
          return {
            first: bound.first.bind(bound),
            all: bound.all.bind(bound),
            async run(...runArgs: unknown[]) {
              counter.writes += 1;
              return bound.run(...(runArgs as []));
            },
          };
        },
      };
    },
    batch: db.batch?.bind(db),
    exec: db.exec?.bind(db),
  } as unknown as D1Database;
}

async function main() {
  assert.equal(SESSION_D1_PRIMARY_TIMEOUT_MS, 500);
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "d1_primary" }), "d1_primary");
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "d1_only" }), "d1_only");
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "primary" }), "off");
  assert.equal(L44B_ROLLBACK_MODE, "dual_write");
  assert.ok(l44bHardGateIds().includes("fingerprint_match"));
  assert.ok(l44bHardGateIds().includes("rollback_dual_write"));

  process.env.SESSION_D1_MODE = "d1_primary";
  assert.equal(isSessionD1PrimaryActive(), true);
  assert.equal(isSessionD1DualWriteActive(), true);
  assert.equal(isSessionD1ShadowActive(), false);

  process.env.SESSION_D1_MODE = "d1_only";
  assert.equal(isSessionD1DualWriteActive(), false);
  assert.equal(isSessionD1ShadowActive(), false);
  process.env.SESSION_D1_MODE = "d1_primary";
  assert.equal(isSessionD1PrimaryActive(), true);

  const session = makeOffline();
  const redisLive = makeOffline();
  assertSafe({ id_hash: hashSessionId(session.id), shop: session.shop });

  const proxy = await getPlatformProxy({ persist: true });
  try {
    const rawDb = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    const writeCounter = { writes: 0 };
    const db = wrapWriteCountingDb(rawDb, writeCounter);
    await rawDb
      .prepare("DELETE FROM shopify_sessions WHERE shop = ? OR id = ?")
      .bind(SHOP, session.id)
      .run();
    const repo = createShopifySessionRepository(rawDb);

    // --- D1 live → D1 return, Redis read 0 ---
    process.env.SESSION_D1_MODE = "d1_primary";
    await repo.storeSession(session);
    const redisHits = { n: 0 };
    writeCounter.writes = 0;
    const hit = await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () =>
        loadSessionD1Primary({
          sessionId: session.id,
          db,
          loadFromRedis: makeRedisLoader(redisLive, redisHits),
        }),
    );
    assert.equal(hit.returned_source, "d1");
    assert.equal(hit.session?.accessToken, TOKEN);
    assert.equal(redisHits.n, 0);
    assert.equal(writeCounter.writes, 0, "D1 hit must not write");
    assert.ok(hit.logs.some((l) => l.category === "session_d1_primary_hit"));
    assertSafe(hit.logs);

    // --- D1 missing → Redis fallback success ---
    await rawDb
      .prepare("DELETE FROM shopify_sessions WHERE id = ?")
      .bind(session.id)
      .run();
    redisHits.n = 0;
    writeCounter.writes = 0;
    const missFb = await loadSessionD1Primary({
      sessionId: session.id,
      db,
      loadFromRedis: makeRedisLoader(redisLive, redisHits),
    });
    assert.equal(missFb.returned_source, "redis");
    assert.equal(missFb.fallback_reason, "missing");
    assert.equal(missFb.session?.id, session.id);
    assert.equal(redisHits.n, 1);
    assert.equal(writeCounter.writes, 0, "fallback must not read-repair");
    assert.ok(missFb.logs.some((l) => l.category === "session_d1_primary_miss"));
    assert.ok(missFb.logs.some((l) => l.category === "session_redis_fallback_success"));

    // --- D1 error → Redis fallback ---
    redisHits.n = 0;
    const errFb = await loadSessionD1Primary({
      sessionId: session.id,
      db: makeErrorDb(),
      loadFromRedis: makeRedisLoader(redisLive, redisHits),
    });
    assert.equal(errFb.returned_source, "redis");
    assert.equal(errFb.fallback_reason, "error");
    assert.equal(redisHits.n, 1);
    assert.ok(errFb.logs.some((l) => l.category === "session_d1_primary_error"));

    // --- D1 timeout → Redis fallback ---
    redisHits.n = 0;
    const toFb = await loadSessionD1Primary({
      sessionId: session.id,
      db: makeSlowDb(SESSION_D1_PRIMARY_TIMEOUT_MS + 80),
      timeoutMs: SESSION_D1_PRIMARY_TIMEOUT_MS,
      loadFromRedis: makeRedisLoader(redisLive, redisHits),
    });
    assert.equal(toFb.returned_source, "redis");
    assert.equal(toFb.fallback_reason, "timeout");
    assert.ok(toFb.d1_latency_ms >= SESSION_D1_PRIMARY_TIMEOUT_MS - 20);
    assert.equal(redisHits.n, 1);
    assert.ok(toFb.logs.some((l) => l.category === "session_d1_primary_timeout"));

    // timeout boundary: finishes under budget → hit path (missing row, then redis)
    redisHits.n = 0;
    const underBudget = await loadSessionD1Primary({
      sessionId: session.id,
      db: makeSlowDb(40),
      timeoutMs: 200,
      loadFromRedis: makeRedisLoader(redisLive, redisHits),
    });
    assert.equal(underBudget.fallback_reason, "missing");
    assert.equal(underBudget.returned_source, "redis");
    assert.ok(underBudget.d1_latency_ms < 200);

    // --- D1 invalid → Redis fallback ---
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
        '{"entries":"not-an-array"}',
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    redisHits.n = 0;
    writeCounter.writes = 0;
    const invFb = await loadSessionD1Primary({
      sessionId: session.id,
      db,
      loadFromRedis: makeRedisLoader(redisLive, redisHits),
    });
    assert.equal(invFb.returned_source, "redis");
    assert.equal(invFb.fallback_reason, "invalid");
    assert.equal(redisHits.n, 1);
    assert.equal(writeCounter.writes, 0);
    assert.ok(invFb.logs.some((l) => l.category === "session_d1_primary_invalid"));

    // --- tombstone + Redis live → not found, no revive ---
    await repo.deleteSession(session.id, { shop: SHOP });
    redisHits.n = 0;
    writeCounter.writes = 0;
    const tomb = await loadSessionD1Primary({
      sessionId: session.id,
      db,
      loadFromRedis: makeRedisLoader(redisLive, redisHits),
    });
    assert.equal(tomb.returned_source, "none");
    assert.equal(tomb.session, undefined);
    assert.equal(tomb.fallback_reason, null);
    assert.equal(redisHits.n, 0, "tombstone must not Redis-fallback");
    assert.equal(writeCounter.writes, 0);
    assert.ok(tomb.logs.some((l) => l.category === "session_d1_primary_tombstone"));

    // --- expired + Redis live → not found ---
    await rawDb
      .prepare("DELETE FROM shopify_sessions WHERE id = ?")
      .bind(session.id)
      .run();
    const expiredPayload = JSON.stringify({
      entries: session.toPropertyArray(true),
      shop: SHOP,
    });
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
        expiredPayload,
        new Date(Date.now() - 60_000).toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    redisHits.n = 0;
    const exp = await loadSessionD1Primary({
      sessionId: session.id,
      db,
      loadFromRedis: makeRedisLoader(redisLive, redisHits),
    });
    assert.equal(exp.returned_source, "none");
    assert.equal(exp.session, undefined);
    assert.equal(redisHits.n, 0);
    assert.ok(exp.logs.some((l) => l.category === "session_d1_primary_expired"));

    // --- D1 missing + Redis missing ---
    await rawDb
      .prepare("DELETE FROM shopify_sessions WHERE id = ?")
      .bind(session.id)
      .run();
    redisHits.n = 0;
    const bothMiss = await loadSessionD1Primary({
      sessionId: session.id,
      db,
      loadFromRedis: makeRedisLoader(undefined, redisHits),
    });
    assert.equal(bothMiss.returned_source, "none");
    assert.equal(bothMiss.fallback_reason, "missing");
    assert.ok(bothMiss.logs.some((l) => l.category === "session_redis_fallback_miss"));

    // --- D1 error + Redis error → safe fail ---
    const bothErr = await loadSessionD1Primary({
      sessionId: session.id,
      db: makeErrorDb(),
      loadFromRedis: async () => {
        throw new Error("redis_boom");
      },
    });
    assert.equal(bothErr.returned_source, "none");
    assert.ok(bothErr.logs.some((l) => l.category === "session_load_failed"));
    assertSafe(bothErr.logs);

    // --- binding missing → Redis fallback ---
    redisHits.n = 0;
    const bindMiss = await loadSessionD1Primary({
      sessionId: session.id,
      // no db, no ALS
      loadFromRedis: makeRedisLoader(redisLive, redisHits),
    });
    assert.equal(bindMiss.returned_source, "redis");
    assert.equal(bindMiss.fallback_reason, "binding_missing");

    // --- d1_primary store: Redis→D1 mirror active ---
    await rawDb
      .prepare("DELETE FROM shopify_sessions WHERE id = ? OR shop = ?")
      .bind(session.id, SHOP)
      .run();
    process.env.SESSION_D1_MODE = "d1_primary";
    await runWithCloudflareEnv(
      { env: { TTI_DB: rawDb } as Env, ctx: {} as ExecutionContext },
      () => mirrorSessionStoreToD1(session),
    );
    const stored = await repo.loadSession(session.id);
    assert.ok(stored);
    assert.equal(stored?.shop, SHOP);

    // equal-ts tombstone priority under d1_primary (repo contract)
    const ts = "2026-07-24T22:00:00.000Z";
    await rawDb
      .prepare("DELETE FROM shopify_sessions WHERE id = ?")
      .bind(session.id)
      .run();
    assert.equal(await repo.storeSession(session, { updatedAt: ts }), true);
    assert.equal(
      await repo.deleteSession(session.id, { shop: SHOP, updatedAt: ts }),
      true,
    );
    assert.equal(
      await repo.storeSession(session, { updatedAt: ts }),
      false,
      "equal-ts live must not beat tombstone",
    );
    const stillTomb = await rawDb
      .prepare("SELECT migration_source FROM shopify_sessions WHERE id = ?")
      .bind(session.id)
      .first<{ migration_source: string }>();
    assert.equal(stillTomb?.migration_source, SESSION_MIGRATION_SOURCE_DELETED);

    // delete mirror under d1_primary (newer than equal-ts tombstone)
    const liveTs = new Date(Date.parse(ts) + 60_000).toISOString();
    assert.equal(await repo.storeSession(session, { updatedAt: liveTs }), true);
    await runWithCloudflareEnv(
      { env: { TTI_DB: rawDb } as Env, ctx: {} as ExecutionContext },
      () => mirrorSessionDeleteToD1({ sessionId: session.id, shop: SHOP }),
    );
    assert.equal(await repo.loadSession(session.id), undefined);

    // --- mode regression: off / shadow / dual_write do not use primary path semantics ---
    process.env.SESSION_D1_MODE = "dual_write";
    assert.equal(isSessionD1PrimaryActive(), false);
    assert.equal(isSessionD1ShadowActive(), true);
    process.env.SESSION_D1_MODE = "shadow";
    assert.equal(isSessionD1DualWriteActive(), false);
    process.env.SESSION_D1_MODE = "off";
    assert.equal(isSessionD1PrimaryActive(), false);

    console.log(
      JSON.stringify({
        type: "session_l44a_primary_tests_ok",
        timeout_ms: SESSION_D1_PRIMARY_TIMEOUT_MS,
        l44b_hard_gates: l44bHardGateIds().length,
      }),
    );
  } finally {
    await proxy.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
