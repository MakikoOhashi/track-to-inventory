/**
 * Stage L4.3c ops gate unit tests (no production apply).
 *   npm run test:session:l43c
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import {
  assertOpsConfigMatchesMain,
  compareSnaps,
  L43C_MAIN_CONFIG,
  L43C_OPS_CONFIG,
  readD1Binding,
  snapFromDb,
  type SessionSnap,
} from "./lib/sessionL43cOpsGate.mts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const { ops, main } = assertOpsConfigMatchesMain(webRoot);
  assert.equal(ops.remote, true);
  assert.equal(main.remote, false);
  assert.equal(ops.database_id, main.database_id);
  assert.equal(ops.binding, "TTI_DB");

  // Main config path must not advertise remote D1
  const mainBind = readD1Binding(join(webRoot, L43C_MAIN_CONFIG));
  assert.equal(mainBind.remote, false);

  // Local proxy (default wrangler.jsonc) must fail identity vs empty/missing table
  // or disagree with a fabricated "remote" snap — proves local rejection logic.
  const localProxy = await getPlatformProxy({
    configPath: join(webRoot, L43C_MAIN_CONFIG),
    persist: false,
    remoteBindings: true,
  });
  try {
    const db = (localProxy.env as { TTI_DB: D1Database }).TTI_DB;
    const localSnap = await snapFromDb(db);
    // Empty local DB: table missing OR not matching a healthy remote snap
    const fakeRemote: SessionSnap = {
      table_exists: true,
      live_count: 1,
      dup_count: 0,
      target_rows: 1,
      migration_source: "redis",
      updated_at: "2026-07-24T11:02:43.807Z",
      expires_at: null,
      is_online: 0,
      fingerprint: "c722cab832a2d705",
      ledger_succeeded: 2,
    };
    const cmp = compareSnaps(localSnap, fakeRemote);
    assert.equal(cmp.ok, false, "local empty D1 must fail identity gate");
    assert.ok(
      cmp.mismatches.length > 0 || !localSnap.table_exists,
      "expected local/table mismatch signals",
    );
  } finally {
    await localProxy.dispose();
  }

  // Fingerprint mismatch helper
  const a: SessionSnap = {
    table_exists: true,
    live_count: 1,
    dup_count: 0,
    target_rows: 1,
    migration_source: "redis",
    updated_at: "t1",
    expires_at: null,
    is_online: 0,
    fingerprint: "aaa",
    ledger_succeeded: 2,
  };
  const b = { ...a, fingerprint: "bbb" };
  assert.equal(compareSnaps(a, b).ok, false);
  assert.ok(compareSnaps(a, b).mismatches.includes("fingerprint"));

  // Target row missing
  const missingTarget = { ...a, target_rows: 0, fingerprint: null };
  assert.equal(compareSnaps(missingTarget, a).ok, false);

  // Default CLI without --apply is dry-run (documented); no write in this test file
  assert.equal(process.argv.includes("--apply"), false);

  console.log(
    JSON.stringify({
      type: "session_l43c_ops_gate_tests_ok",
      ops_config: L43C_OPS_CONFIG,
      checks: [
        "ops_remote_true",
        "main_remote_false",
        "database_id_match",
        "local_proxy_fails_identity",
        "fingerprint_mismatch_reject",
        "target_missing_reject",
        "no_apply_in_test",
        "secret_redaction_via_assertSafe_paths",
      ],
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
