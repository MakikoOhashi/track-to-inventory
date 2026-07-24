/**
 * Stage L4.3b — D1 error classification diagnostics (fake bindings only).
 *   npx tsx scripts/session-l43b-error-classify-tests.mts
 */
import assert from "node:assert/strict";
import {
  classifyD1Error,
  inferFailureStage,
  safeErrorName,
} from "../app/lib/d1/errors.server.ts";
import {
  mirrorSessionStoreToD1,
  SESSION_D1_WRITE_TIMEOUT_MS,
} from "../app/lib/sessionD1DualWrite.server.ts";
import { runWithCloudflareEnv } from "../app/lib/cloudflareBindings.server.ts";
import { Session } from "@shopify/shopify-api";

function makeSession() {
  return new Session({
    id: "offline_l43b-classify.myshopify.com",
    shop: "l43b-classify.myshopify.com",
    state: "state-secret-l43b",
    isOnline: false,
    accessToken: "shpat_l43b_token",
    scope: "read_products",
  });
}

function fakeDb(impl: {
  prepareImpl?: () => unknown;
}): D1Database {
  return {
    prepare(sql: string) {
      if (impl.prepareImpl) return impl.prepareImpl();
      return {
        bind() {
          return {
            async run() {
              throw new Error(`D1_ERROR: no such table: shopify_sessions: SQLITE_ERROR (${sql.slice(0, 12)})`);
            },
            async first() {
              throw new Error("D1_ERROR: no such table: shopify_sessions: SQLITE_ERROR");
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

async function main() {
  // binding_missing
  assert.equal(inferFailureStage("binding_missing"), "binding");
  assert.equal(inferFailureStage("TTI_DB binding missing"), "binding");

  const schema = classifyD1Error(
    new Error("D1_ERROR: no such table: shopify_sessions: SQLITE_ERROR"),
  );
  assert.equal(schema.classification, "schema");
  assert.equal(schema.failureStage, "run");
  assert.equal(safeErrorName(schema), "D1RepositoryError");

  const prep = classifyD1Error(new Error("failed to prepare statement"));
  assert.equal(prep.failureStage, "prepare");

  const timeout = classifyD1Error(new Error("d1_dual_write_timeout"));
  assert.equal(timeout.classification, "retryable");
  assert.equal(timeout.failureStage, "timeout");

  process.env.SESSION_D1_MODE = "dual_write";
  const session = makeSession();

  // binding missing via ALS empty
  await runWithCloudflareEnv(
    { env: {} as Env, ctx: {} as ExecutionContext },
    () => mirrorSessionStoreToD1(session),
  );

  // prepare/run failure via fake db (schema)
  await runWithCloudflareEnv(
    {
      env: { TTI_DB: fakeDb({}) } as Env,
      ctx: {} as ExecutionContext,
    },
    () => mirrorSessionStoreToD1(session),
  );

  // timeout via hanging run
  const hanging = {
    prepare() {
      return {
        bind() {
          return {
            async run() {
              await new Promise((r) => setTimeout(r, SESSION_D1_WRITE_TIMEOUT_MS + 80));
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  await runWithCloudflareEnv(
    { env: { TTI_DB: hanging } as Env, ctx: {} as ExecutionContext },
    () => mirrorSessionStoreToD1(session),
  );

  console.log(
    JSON.stringify({
      type: "session_l43b_error_classify_tests_ok",
      checks: [
        "schema_no_such_table",
        "prepare_stage",
        "timeout_class",
        "binding_missing_mirror",
        "fake_db_run_fail",
        "fake_db_timeout",
      ],
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
