// app/lib/redis.server.ts
// Shared Upstash Redis client for session / sync ledger / Notion.
// Usage / plan OCR·AI·delete counters live in D1 (Stage L5.5) — not here.
import { Redis } from "@upstash/redis";
import { authenticate } from "~/shopify.server";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/**
 * Shopify認証を使用してストアIDを取得（ページルート用）
 */
export async function getStoreIdFromAuth(request: Request): Promise<string> {
  try {
    const { session } = await authenticate.admin(request);
    return session.shop;
  } catch {
    throw new Error("認証に失敗しました");
  }
}
