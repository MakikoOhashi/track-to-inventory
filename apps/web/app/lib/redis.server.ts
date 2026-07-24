// app/lib/redis.server.ts
import { Redis } from '@upstash/redis'
import { createClient } from '@supabase/supabase-js'
import { authenticate } from "~/shopify.server"
import {
  getStringPreferNew,
  incrHydrateFromLegacy,
} from "~/lib/redisCompat.server"
import {
  aiUsageKey,
  aiUsageKeyLegacy,
  deleteUsageKey,
  deleteUsageKeyLegacy,
  ocrUsageKey,
  ocrUsageKeyLegacy,
  planKey,
  planKeyLegacy,
} from "~/lib/redisKeys.server"

// Redisクライアント初期化
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

// Supabaseクライアント初期化
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
// ===== プラン設定 =====

export type UserPlan = 'free' | 'basic' | 'pro'

const PLAN_LIMITS = {
  free: { ai: 5, ocr: 3, si: 10 },
  basic: { ai: 50, ocr: 20, si: 100 },
  pro: { ai: Infinity, ocr: Infinity, si: Infinity },
} as const

// ===== ストアID取得 =====

/**
 * Shopify認証を使用してストアIDを取得（ページルート用）
 */
export async function getStoreIdFromAuth(request: Request): Promise<string> {
  try {
    const { session } = await authenticate.admin(request)
    return session.shop
  } catch (error) {
    throw new Error('認証に失敗しました')
  }
}

/**
 * ストア情報を取得
 */
export async function getStoreInfo(storeId: string) {
  const plan = await getUserPlan(storeId)
  const limits = PLAN_LIMITS[plan]
  
  return {
    storeId,
    plan,
    limits,
  }
}

// ===== プラン管理 =====

/**
 * ユーザーのプランを設定
 */
export async function setUserPlan(userId: string, plan: UserPlan): Promise<void> {
  await redis.set(planKey(userId), plan)
}

/**
 * ユーザーのプランを取得
 */
export async function getUserPlan(userId: string): Promise<UserPlan> {
  const plan = await getStringPreferNew(redis, planKey(userId), planKeyLegacy(userId))
  return (plan as UserPlan) || 'free'
}

// ===== 月次管理 =====

function getCurrentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

// ===== AI使用回数制限 =====

/**
 * AI使用回数をチェックしてインクリメント
 */
export async function checkAndIncrementAI(userId: string): Promise<void> {
  const month = getCurrentMonth()
  const plan = await getUserPlan(userId)
  const limit = PLAN_LIMITS[plan].ai
  
  if (limit === Infinity) {
    return
  }
  
  const currentCount = Number(
    (await getStringPreferNew(redis, aiUsageKey(userId, month), aiUsageKeyLegacy(userId, month))) ?? 0,
  )
  
  if (currentCount >= limit) {
    throw new Error("AI_LIMIT_EXCEEDED")
  }
  
  await incrHydrateFromLegacy(redis, aiUsageKey(userId, month), aiUsageKeyLegacy(userId, month))
}

// ===== OCR使用回数制限 =====

/**
 * OCR使用回数をチェックしてインクリメント
 */
export async function checkAndIncrementOCR(userId: string): Promise<void> {
  const month = getCurrentMonth()
  const plan = await getUserPlan(userId)
  const limit = PLAN_LIMITS[plan].ocr
  
  if (limit === Infinity) {
    return
  }
  
  const currentCount = Number(
    (await getStringPreferNew(redis, ocrUsageKey(userId, month), ocrUsageKeyLegacy(userId, month))) ?? 0,
  )
  
  if (currentCount >= limit) {
    throw new Error("OCR_LIMIT_EXCEEDED")
  }
  
  await incrHydrateFromLegacy(redis, ocrUsageKey(userId, month), ocrUsageKeyLegacy(userId, month))
}

// ===== 使用状況取得 =====

/**
 * ユーザーの使用状況を取得
 */
export async function getUserUsage(userId: string) {
  const month = getCurrentMonth()
  const plan = await getUserPlan(userId)
  const limits = PLAN_LIMITS[plan]
  
  // 現在の使用回数を取得
  const [aiCount, ocrCount] = await Promise.all([
    getStringPreferNew(redis, aiUsageKey(userId, month), aiUsageKeyLegacy(userId, month)).then(
      (count) => Number(count ?? 0),
    ),
    getStringPreferNew(redis, ocrUsageKey(userId, month), ocrUsageKeyLegacy(userId, month)).then(
      (count) => Number(count ?? 0),
    ),
  ])

  // SupabaseでSI登録件数取得
  let siCount = 0
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      siCount = 0
    } else {
      const { count, error } = await supabase
        .from('shipments')
        .select('*', { count: 'exact', head: true })
        .eq('shop_id', userId)
      
      if (error) {
        siCount = 0
      } else {
        siCount = count || 0
      }
    }
  } catch (error) {
    siCount = 0 // エラー時は0件として扱う
  }

  
  // remainingはマイナスも許容
  const siCurrent = typeof siCount === "number" && !isNaN(siCount) ? siCount : 0
  const siLimit = limits.si
  const siRemaining = siLimit === Infinity ? Infinity : siLimit - siCurrent

  
  return {
    plan,
    month,
    usage: {
      ai: {
        current: aiCount,
        limit: limits.ai,
        remaining: limits.ai === Infinity ? Infinity : limits.ai - aiCount,
      },
      ocr: {
        current: ocrCount,
        limit: limits.ocr,
        remaining: limits.ocr === Infinity ? Infinity : limits.ocr - ocrCount,
      },
      si: {
        current: siCount,
        limit: limits.si,
        remaining: siRemaining, // ここがマイナスもありうる
      },
    },
  }
}

// === SI登録件数制限チェック ===

/**
 * SI登録件数をチェック
 */
export async function checkSILimit(userId: string): Promise<void> {
  const plan = await getUserPlan(userId)
  const limit = PLAN_LIMITS[plan].si
  
  if (limit === Infinity) {
    return
  }
  
  // Supabaseから現在のSI登録件数を取得
  let currentCount = 0
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Supabase環境変数が設定されていません')
    }
    
    const { count, error } = await supabase
      .from('shipments')
      .select('*', { count: 'exact', head: true })
      .eq('shop_id', userId)
    
    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`)
    }
    
    currentCount = count || 0
    
    if (currentCount >= limit) {
      throw new Error("SI_LIMIT_EXCEEDED")
    }
  } catch (error) {
    if (getErrorMessage(error).includes('SI_LIMIT_EXCEEDED')) {
      throw error
    }
    throw new Error(`SI_LIMIT_CHECK_FAILED: ${getErrorMessage(error)}`)
  }
}

// ===== ユーティリティ =====

/**
 * エラーメッセージを安全に取得
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

// ===== 削除回数制限 =====

/**
 * 削除回数をチェック
 */
export async function checkDeleteLimit(shopId: string, limit: number) {
  const month = getCurrentMonth()
  const currentCount = Number(
    (await getStringPreferNew(
      redis,
      deleteUsageKey(shopId, month),
      deleteUsageKeyLegacy(shopId, month),
    )) ?? 0,
  )
  
  if (currentCount >= limit) {
    throw new Error("DELETE_LIMIT_EXCEEDED")
  }
}

/**
 * 削除回数をインクリメント
 */
export async function incrementDeleteCount(shopId: string) {
  const month = getCurrentMonth()
  await incrHydrateFromLegacy(
    redis,
    deleteUsageKey(shopId, month),
    deleteUsageKeyLegacy(shopId, month),
  )
}
