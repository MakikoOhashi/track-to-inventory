/**
 * Stage L5.5 — D1-only usage/plan gateway (no Redis, no USAGE_D1_MODE).
 *   npm run test:usage:l55
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { runWithCloudflareEnv } from "../app/lib/cloudflareBindings.server.ts";
import {
  checkDeleteUsageLimit,
  getPlanViaGateway,
  getUsageForDisplay,
  persistUserPlan,
  recordDeleteUsage,
  refundOcrOrAiUsage,
  reserveOcrOrAiUsage,
} from "../app/lib/usageGateway.server.ts";
import { createUsageQuotaRepository } from "../app/lib/d1/usageQuota.server.ts";
import { utcPeriodYm } from "../app/lib/d1/planLimits.server.ts";

const SHOP = "l55-test.myshopify.com";
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  // Gateway must not import Redis / mode flag
  const gatewaySrc = readFileSync(
    join(webRoot, "app/lib/usageGateway.server.ts"),
    "utf8",
  );
  assert.equal(/from\s+["']~\/lib\/redis\.server["']/.test(gatewaySrc), false);
  assert.equal(/from\s+["']~\/lib\/usageD1Mode\.server["']/.test(gatewaySrc), false);
  assert.equal(/@upstash\/redis/.test(gatewaySrc), false);
  assert.equal(/getUsageD1Mode|isUsageD1ShadowActive/.test(gatewaySrc), false);
  assert.equal(
    /checkAndIncrementOCR|checkAndIncrementAI|setUserPlan|getUserPlan/.test(
      readFileSync(join(webRoot, "app/lib/redis.server.ts"), "utf8"),
    ),
    false,
  );

  const proxy = await getPlatformProxy({ persist: true });
  try {
    const env = proxy.env as Env;
    const db = env.TTI_DB;
    assert.ok(db, "TTI_DB required");

    await db.prepare("DELETE FROM usage_operations WHERE shop_id = ?").bind(SHOP).run();
    await db.prepare("DELETE FROM usage_counters WHERE shop_id = ?").bind(SHOP).run();
    await db.prepare("DELETE FROM shop_plans WHERE shop_id = ?").bind(SHOP).run();
    await db.prepare("DELETE FROM shops WHERE shop_id = ?").bind(SHOP).run();

    await runWithCloudflareEnv(
      { env, ctx: proxy.ctx as ExecutionContext },
      async () => {
        await persistUserPlan(SHOP, "basic", "test_l55");
        assert.equal(await getPlanViaGateway(SHOP), "basic");

        const r1 = await reserveOcrOrAiUsage({ shopId: SHOP, kind: "ocr" });
        assert.equal(r1.source, "d1");
        const repo = createUsageQuotaRepository(db);
        const period = utcPeriodYm();
        assert.equal(await repo.getCount(SHOP, "ocr", period), 1);

        await refundOcrOrAiUsage({
          shopId: SHOP,
          kind: "ocr",
          operationId: r1.operationId,
        });
        assert.equal(await repo.getCount(SHOP, "ocr", period), 0);

        await reserveOcrOrAiUsage({ shopId: SHOP, kind: "ai" });
        assert.equal(await repo.getCount(SHOP, "ai", period), 1);

        await checkDeleteUsageLimit(SHOP, 2);
        await recordDeleteUsage({ shopId: SHOP, operationId: randomUUID() });
        assert.equal(await repo.getCount(SHOP, "delete", period), 1);

        const display = await getUsageForDisplay(SHOP);
        assert.equal(display.plan, "basic");
        assert.equal(display.usage.ocr.current, 0);
        assert.equal(display.usage.ai.current, 1);
        assert.equal(display.month, period);

        await persistUserPlan(SHOP, "free", "test_l55_free");
        await db
          .prepare("DELETE FROM usage_operations WHERE shop_id = ? AND kind = 'ocr'")
          .bind(SHOP)
          .run();
        await db
          .prepare("DELETE FROM usage_counters WHERE shop_id = ? AND kind = 'ocr'")
          .bind(SHOP)
          .run();
        for (let i = 0; i < 3; i++) {
          await reserveOcrOrAiUsage({ shopId: SHOP, kind: "ocr" });
        }
        let limited = false;
        try {
          await reserveOcrOrAiUsage({ shopId: SHOP, kind: "ocr" });
        } catch (e) {
          limited = e instanceof Error && e.message === "OCR_LIMIT_EXCEEDED";
        }
        assert.equal(limited, true);
      },
    );

    console.log("usage-l55-gateway-tests: ok");
  } finally {
    await proxy.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
