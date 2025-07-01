// app/lib/redis.server.ts
import { Redis } from '@upstash/redis'
import { createClient } from '@supabase/supabase-js'
import { authenticate } from "~/shopify.server"

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
    console.error('Shopify認証エラー:', error)
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
  await redis.set(`plan:${userId}`, plan)
}

/**
 * ユーザーのプランを取得
 */
export async function getUserPlan(userId: string): Promise<UserPlan> {
  const plan = await redis.get<UserPlan>(`plan:${userId}`)
  return plan || 'free'
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
  
  const currentCount = await redis.get<number>(`ai:${userId}:${month}`) ?? 0
  
  if (currentCount >= limit) {
    throw new Error(`AI使用回数の上限（${limit}回）に達しました。プランをアップグレードしてください。`)
  }
  
  await redis.incr(`ai:${userId}:${month}`)
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
  
  const currentCount = await redis.get<number>(`ocr:${userId}:${month}`) ?? 0
  
  if (currentCount >= limit) {
    throw new Error(`OCR使用回数の上限（${limit}回）に達しました。プランをアップグレードしてください。`)
  }
  
  await redis.incr(`ocr:${userId}:${month}`)
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
    redis.get<number>(`ai:${userId}:${month}`).then(count => count ?? 0),
    redis.get<number>(`ocr:${userId}:${month}`).then(count => count ?? 0),
  ])

  // SupabaseでSI登録件数取得
  let siCount = 0
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.warn('Supabase環境変数が設定されていません')
      siCount = 0
    } else {
      const { count, error } = await supabase
        .from('shipments')
        .select('*', { count: 'exact', head: true })
        .eq('shop_id', userId)
      
      if (error) {
        console.error('Supabase SI件数取得エラー:', error)
        siCount = 0
      } else {
        siCount = count || 0
      }
    }
  } catch (error) {
    console.error('SI件数取得エラー:', getErrorMessage(error))
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
      throw new Error(`SI登録件数の上限（${limit}件）に達しました。プランをアップグレードしてください。`)
    }
  } catch (error) {
    if (getErrorMessage(error).includes('SI登録件数の上限')) {
      throw error
    }
    throw new Error(`SI登録件数の確認中にエラーが発生しました。詳細: ${getErrorMessage(error)}`)
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
  const currentCount = await redis.get<number>(`delete:${shopId}:${month}`) ?? 0
  
  if (currentCount >= limit) {
    throw new Error(`削除回数の上限（${limit}回）に達しました。`)
  }
}

/**
 * 削除回数をインクリメント
 */
export async function incrementDeleteCount(shopId: string) {
  const month = getCurrentMonth()
  await redis.incr(`delete:${shopId}:${month}`)
}