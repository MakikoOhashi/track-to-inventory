/**
 * Stage L8.1: Notion metadata D1 repository tests (local D1 only).
 *
 * Run: npm run test:d1:l81
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPlatformProxy } from "wrangler";
import {
  createNotionConnectionRepository,
  createNotionOAuthStateRepository,
  createNotionProvisionLockRepository,
} from "../app/lib/d1/notionMetadata.server.ts";
import type { EncryptedBlob } from "../app/lib/tokenEncryption.server.ts";

const SHOP = "l81-notion.myshopify.com";
const OTHER_SHOP = "l81-other.myshopify.com";

const FAKE_ENC: EncryptedBlob = {
  v: 1,
  iv: "dGVzdC1pdi12YWx1ZQ==",
  ciphertext: "dGVzdC1jaXBoZXJ0ZXh0",
};

async function resetNotionTables(db: D1Database) {
  await db.batch([
    db.prepare("DELETE FROM notion_connections"),
    db.prepare("DELETE FROM notion_oauth_states"),
    db.prepare("DELETE FROM notion_provision_locks"),
  ]);
}

function connectionRecord(overrides: Partial<{
  shop_id: string;
  status: "connected" | "provisioned" | "error" | "revoked";
  parent_page_id: string | null;
  shipments_database_id: string | null;
}> = {}) {
  const now = new Date().toISOString();
  return {
    shop_id: overrides.shop_id ?? SHOP,
    workspace_id: "ws-1",
    workspace_name: "Test Workspace",
    bot_id: "bot-1",
    access_token: FAKE_ENC,
    parent_page_id: overrides.parent_page_id ?? null,
    shipments_database_id: overrides.shipments_database_id ?? null,
    shipments_data_source_id: null,
    schema_version: null,
    status: overrides.status ?? "connected",
    last_error: null,
    connected_at: now,
    created_at: now,
    updated_at: now,
  };
}

async function seedExpiredOAuthState(
  db: D1Database,
  state: string,
  shopId = SHOP,
) {
  const past = new Date(Date.now() - 60_000).toISOString();
  const created = new Date(Date.now() - 120_000).toISOString();
  await db
    .prepare(
      `INSERT INTO notion_oauth_states (
         state, shop_id, return_path, expires_at,
         migration_source, migration_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'test', 'l81', ?, ?)`,
    )
    .bind(state, shopId, "/app/notion", past, created, created)
    .run();
}

async function seedExpiredProvisionLock(db: D1Database, shopId = SHOP) {
  const past = new Date(Date.now() - 60_000).toISOString();
  const created = new Date(Date.now() - 120_000).toISOString();
  await db
    .prepare(
      `INSERT INTO notion_provision_locks (
         shop_id, owner_token, expires_at,
         migration_source, migration_version, created_at, updated_at
       ) VALUES (?, ?, ?, 'test', 'l81', ?, ?)`,
    )
    .bind(shopId, "expired-owner", past, created, created)
    .run();
}

async function main() {
  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    assert.ok(db, "TTI_DB binding missing");

    const connections = createNotionConnectionRepository(db);
    const oauthStates = createNotionOAuthStateRepository(db);
    const provisionLocks = createNotionProvisionLockRepository(db);

    await resetNotionTables(db);

    // --- schema columns present (post 0003 migration) ---
    const connInfo = await db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='notion_connections'",
      )
      .first<{ sql: string }>();
    assert.ok(connInfo?.sql?.includes("parent_page_id"), "parent_page_id column");
    assert.ok(
      connInfo?.sql?.includes("shipments_data_source_id"),
      "shipments_data_source_id column",
    );
    assert.ok(connInfo?.sql?.includes("schema_version"), "schema_version column");
    assert.ok(connInfo?.sql?.includes("connected_at"), "connected_at column");

    const oauthInfo = await db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='notion_oauth_states'",
      )
      .first<{ sql: string }>();
    assert.ok(oauthInfo?.sql?.includes("return_path"), "return_path column");

    // --- connection upsert / get / delete ---
    const first = connectionRecord();
    await connections.upsert(first);
    const loaded = await connections.get(SHOP);
    assert.ok(loaded);
    assert.equal(loaded.shop_id, SHOP);
    assert.equal(loaded.workspace_id, "ws-1");
    assert.deepEqual(loaded.access_token, FAKE_ENC);

    const encRow = await db
      .prepare(
        "SELECT access_token_enc FROM notion_connections WHERE shop_id = ?",
      )
      .bind(SHOP)
      .first<{ access_token_enc: string }>();
    assert.ok(encRow?.access_token_enc);
    assert.ok(!encRow.access_token_enc.includes("secret-token-plain"));
    assert.doesNotMatch(encRow.access_token_enc, /secret-token-plain/);

    const connectedAt = loaded.connected_at;
    await connections.upsert(
      connectionRecord({
        status: "provisioned",
        parent_page_id: "page-1",
        shipments_database_id: "db-1",
      }),
    );
    const updated = await connections.get(SHOP);
    assert.equal(updated?.status, "provisioned");
    assert.equal(updated?.parent_page_id, "page-1");
    assert.equal(updated?.shipments_database_id, "db-1");
    assert.equal(updated?.connected_at, connectedAt, "connected_at preserved on upsert");

    assert.equal(await connections.delete(OTHER_SHOP), false);
    assert.equal(await connections.delete(SHOP), true);
    assert.equal(await connections.get(SHOP), undefined);

    // shop uniqueness
    let dupShopRejected = false;
    try {
      await db
        .prepare(
          `INSERT INTO notion_connections (
             shop_id, access_token_enc, status, connected_at, created_at, updated_at
           ) VALUES (?, ?, 'connected', ?, ?, ?)`,
        )
        .bind(SHOP, JSON.stringify(FAKE_ENC), new Date().toISOString(), new Date().toISOString(), new Date().toISOString())
        .run();
      await db
        .prepare(
          `INSERT INTO notion_connections (
             shop_id, access_token_enc, status, connected_at, created_at, updated_at
           ) VALUES (?, ?, 'connected', ?, ?, ?)`,
        )
        .bind(SHOP, JSON.stringify(FAKE_ENC), new Date().toISOString(), new Date().toISOString(), new Date().toISOString())
        .run();
    } catch {
      dupShopRejected = true;
    }
    assert.ok(dupShopRejected, "duplicate shop_id rejected");

    await resetNotionTables(db);

    // --- oauth save / consume ---
    const state = `state-${randomUUID()}`;
    await oauthStates.save({
      state,
      shopId: SHOP,
      returnPath: "/app/notion",
      ttlSeconds: 600,
    });
    const consumed = await oauthStates.consume(state);
    assert.ok(consumed);
    assert.equal(consumed.shop_id, SHOP);
    assert.equal(consumed.return_path, "/app/notion");
    assert.equal(await oauthStates.consume(state), undefined, "second consume fails");

    // expired state rejected
    const expiredState = `expired-${randomUUID()}`;
    await seedExpiredOAuthState(db, expiredState);
    assert.equal(await oauthStates.consume(expiredState), undefined);

    // concurrent oauth consume: exactly one winner
    await resetNotionTables(db);
    const raceState = `race-oauth-${randomUUID()}`;
    await oauthStates.save({ state: raceState, shopId: SHOP, ttlSeconds: 600 });
    const oauthRace = await Promise.all(
      Array.from({ length: 10 }, () => oauthStates.consume(raceState)),
    );
    const oauthWinners = oauthRace.filter(Boolean);
    assert.equal(oauthWinners.length, 1, "oauth concurrent consume: one winner");
    const oauthRowCount = await db
      .prepare("SELECT COUNT(*) AS c FROM notion_oauth_states WHERE state = ?")
      .bind(raceState)
      .first<{ c: number }>();
    assert.equal(Number(oauthRowCount?.c), 0, "consumed state row removed");

    // --- provision lock acquire / release ---
    await resetNotionTables(db);
    const lock1 = await provisionLocks.acquire(SHOP);
    assert.equal(lock1.ok, true);
    if (!lock1.ok) throw new Error("expected lock acquire");
    const lockRow = await provisionLocks.get(SHOP);
    assert.ok(lockRow);
    assert.equal(lockRow.owner_token, lock1.ownerToken);

    const busy = await provisionLocks.acquire(SHOP);
    assert.equal(busy.ok, false);
    if (busy.ok) throw new Error("expected lock busy");
    assert.equal(busy.reason, "LOCK_BUSY");

    assert.equal(await provisionLocks.release(SHOP, "wrong-token"), false);
    assert.equal(await provisionLocks.release(SHOP, lock1.ownerToken), true);
    assert.equal(await provisionLocks.get(SHOP), undefined);

    // concurrent acquire: exactly one winner
    await resetNotionTables(db);
    const lockRace = await Promise.all(
      Array.from({ length: 12 }, () => provisionLocks.acquire(SHOP)),
    );
    const lockWinners = lockRace.filter((r) => r.ok);
    assert.equal(lockWinners.length, 1, "provision lock concurrent acquire: one winner");
    assert.equal(
      lockRace.filter((r) => !r.ok && r.reason === "LOCK_BUSY").length,
      11,
      "provision lock concurrent acquire: eleven busy",
    );

    // expired lock reclaim
    await resetNotionTables(db);
    await seedExpiredProvisionLock(db);
    const reclaimed = await provisionLocks.acquire(SHOP);
    assert.equal(reclaimed.ok, true);
    if (!reclaimed.ok) throw new Error("expected reclaim");
    assert.notEqual(reclaimed.ownerToken, "expired-owner");

    await resetNotionTables(db);

    console.log(
      JSON.stringify({
        type: "d1_l81_notion_tests_ok",
        checks: [
          "schema_columns",
          "connection_upsert_get_delete",
          "encrypted_token_storage",
          "connected_at_preserved",
          "shop_uniqueness",
          "oauth_consume_once",
          "oauth_expired_rejected",
          "oauth_concurrent_single_winner",
          "provision_lock_acquire_release",
          "provision_release_owner_mismatch",
          "provision_concurrent_single_winner",
          "provision_expired_reclaim",
        ],
      }),
    );
  } finally {
    await proxy.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
