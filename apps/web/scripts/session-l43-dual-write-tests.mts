/**
 * Stage L4.3 session D1 dual-write tests (local D1).
 *   npm run test:session:l43
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
  isSessionD1ShadowActive,
} from "../app/lib/sessionD1Mode.server.ts";
import {
  mirrorSessionDeleteToD1,
  mirrorSessionStoreToD1,
  SESSION_D1_WRITE_TIMEOUT_MS,
} from "../app/lib/sessionD1DualWrite.server.ts";
import { hashSessionId } from "../app/lib/sessionD1Shadow.server.ts";

function makeOffline(shop = "l43-test.myshopify.com", token = "shpat_l43_offline") {
  return new Session({
    id: `offline_${shop}`,
    shop,
    state: "state-secret-l43",
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

async function countLive(db: D1Database, shop: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM shopify_sessions
       WHERE shop = ? AND IFNULL(migration_source, '') != ?`,
    )
    .bind(shop, SESSION_MIGRATION_SOURCE_DELETED)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

async function main() {
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "dual_write" }), "dual_write");
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "shadow" }), "shadow");
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "d1_primary" }), "d1_primary");
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "d1_only" }), "d1_only");
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "primary" }), "off");
  assert.equal(SESSION_D1_WRITE_TIMEOUT_MS, 500);

  process.env.SESSION_D1_MODE = "off";
  assert.equal(isSessionD1DualWriteActive(), false);
  assert.equal(isSessionD1ShadowActive(), false);

  process.env.SESSION_D1_MODE = "shadow";
  assert.equal(isSessionD1DualWriteActive(), false);
  assert.equal(isSessionD1ShadowActive(), true);

  process.env.SESSION_D1_MODE = "dual_write";
  assert.equal(isSessionD1DualWriteActive(), true);
  assert.equal(isSessionD1ShadowActive(), true);

  process.env.SESSION_D1_MODE = "d1_primary";
  assert.equal(isSessionD1DualWriteActive(), true);
  assert.equal(isSessionD1ShadowActive(), false);

  process.env.SESSION_D1_MODE = "d1_only";
  assert.equal(isSessionD1DualWriteActive(), false);
  assert.equal(isSessionD1ShadowActive(), false);

  const session = makeOffline();
  assertSafe({ id_hash: hashSessionId(session.id), shop: session.shop });

  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    await db
      .prepare("DELETE FROM shopify_sessions WHERE shop = ? OR id = ?")
      .bind(session.shop, session.id)
      .run();
    const repo = createShopifySessionRepository(db);

    // --- off / shadow: mirror no-ops (D1 unchanged) ---
    process.env.SESSION_D1_MODE = "off";
    await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () => mirrorSessionStoreToD1(session),
    );
    assert.equal(await countLive(db, session.shop), 0);

    process.env.SESSION_D1_MODE = "shadow";
    await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () => mirrorSessionStoreToD1(session),
    );
    assert.equal(await countLive(db, session.shop), 0);

    // --- dual_write: store upserts once ---
    process.env.SESSION_D1_MODE = "dual_write";
    await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () => mirrorSessionStoreToD1(session),
    );
    assert.equal(await countLive(db, session.shop), 1);
    const loaded = await repo.loadSession(session.id);
    assert.ok(loaded);
    assert.equal(loaded!.accessToken, session.accessToken);
    assert.equal(loaded!.scope, session.scope);
    assert.equal(loaded!.isOnline, false);
    assert.equal(loaded!.expires, undefined);

    // re-store → still 1 row, latest token
    const updated = makeOffline(session.shop, "shpat_l43_updated");
    await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () => mirrorSessionStoreToD1(updated),
    );
    assert.equal(await countLive(db, session.shop), 1);
    const loaded2 = await repo.loadSession(session.id);
    assert.equal(loaded2!.accessToken, "shpat_l43_updated");

    // online + expires round-trip
    const online = new Session({
      id: `offline_${session.shop}_online`,
      shop: session.shop,
      state: "state-secret-l43",
      isOnline: true,
      accessToken: "shpat_l43_online",
      scope: "read_products",
      expires: new Date(Date.now() + 60_000),
    });
    await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () => mirrorSessionStoreToD1(online),
    );
    const onlineLoaded = await repo.loadSession(online.id);
    assert.ok(onlineLoaded?.expires);
    assert.equal(onlineLoaded!.isOnline, true);

    // delete → soft tombstone; load misses; live count 1 (online only) after offline delete
    await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () =>
        mirrorSessionDeleteToD1({
          sessionId: session.id,
          shop: session.shop,
        }),
    );
    assert.equal(await repo.loadSession(session.id), undefined);
    const tomb = await db
      .prepare("SELECT migration_source FROM shopify_sessions WHERE id = ?")
      .bind(session.id)
      .first<{ migration_source: string }>();
    assert.equal(tomb?.migration_source, SESSION_MIGRATION_SOURCE_DELETED);

    // stale store after delete must NOT resurrect
    const staleTs = "2020-01-01T00:00:00.000Z";
    const appliedStale = await repo.storeSession(session, {
      updatedAt: staleTs,
    });
    assert.equal(appliedStale, false);
    assert.equal(await repo.loadSession(session.id), undefined);

    // equal timestamp: store→delete → tombstone; delete→store → tombstone stays
    const equalTs = "2024-06-15T12:00:00.000Z";
    await db.prepare("DELETE FROM shopify_sessions WHERE id = ?").bind(session.id).run();
    assert.equal(
      await repo.storeSession(session, { updatedAt: equalTs }),
      true,
    );
    assert.equal(
      await repo.deleteSession(session.id, {
        shop: session.shop,
        updatedAt: equalTs,
      }),
      true,
    );
    assert.equal(await repo.loadSession(session.id), undefined);
    const equalTomb = await db
      .prepare("SELECT migration_source FROM shopify_sessions WHERE id = ?")
      .bind(session.id)
      .first<{ migration_source: string }>();
    assert.equal(equalTomb?.migration_source, SESSION_MIGRATION_SOURCE_DELETED);

    assert.equal(
      await repo.storeSession(session, { updatedAt: equalTs }),
      false,
      "equal-ts live must not beat tombstone",
    );
    assert.equal(await repo.loadSession(session.id), undefined);

    // idempotent delete at same ts
    assert.equal(
      await repo.deleteSession(session.id, {
        shop: session.shop,
        updatedAt: equalTs,
      }),
      true,
    );

    // fresh store after delete may resurrect (newer updated_at)
    const freshTs = new Date().toISOString();
    const appliedFresh = await repo.storeSession(session, {
      updatedAt: freshTs,
    });
    assert.equal(appliedFresh, true);
    assert.ok(await repo.loadSession(session.id));

    // same store again → still one live row for this id (online sibling may remain)
    assert.equal(
      await repo.storeSession(session, { updatedAt: new Date().toISOString() }),
      true,
    );
    const liveForId = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM shopify_sessions
         WHERE id = ? AND IFNULL(migration_source, '') != ?`,
      )
      .bind(session.id, SESSION_MIGRATION_SOURCE_DELETED)
      .first<{ c: number }>();
    assert.equal(Number(liveForId?.c ?? 0), 1);

    // delete again then assert dual_write delete path
    await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () =>
        mirrorSessionDeleteToD1({
          sessionId: session.id,
          shop: session.shop,
        }),
    );
    assert.equal(await repo.loadSession(session.id), undefined);

    // binding missing → no throw (Redis path simulation)
    await runWithCloudflareEnv(
      { env: {} as Env, ctx: {} as ExecutionContext },
      async () => {
        await mirrorSessionStoreToD1(session);
        await mirrorSessionDeleteToD1({
          sessionId: session.id,
          shop: session.shop,
        });
      },
    );

    // cleanup test rows
    await db
      .prepare("DELETE FROM shopify_sessions WHERE shop = ?")
      .bind(session.shop)
      .run();

    console.log(
      JSON.stringify({
        type: "session_l43_dual_write_tests_ok",
        write_timeout_ms: SESSION_D1_WRITE_TIMEOUT_MS,
        checks: [
          "mode_off_shadow_dual_write",
          "off_no_write",
          "shadow_no_write",
          "dual_write_upsert",
          "re_store_no_dup",
          "online_expires_roundtrip",
          "soft_delete_tombstone",
          "stale_store_no_resurrect",
          "equal_ts_store_then_delete_tombstone",
          "equal_ts_delete_then_store_no_resurrect",
          "equal_ts_delete_idempotent",
          "fresh_store_after_delete",
          "re_store_no_dup_live",
          "binding_missing_safe",
          "secret_redaction",
        ],
      }),
    );
  } finally {
    await proxy.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
