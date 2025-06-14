// app/lib/redis.server.ts
import { Redis } from '@upstash/redis'
import { authenticate } from "~/shopify.server"

// Redis接続設定
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

// プラン型定義
export type UserPlan = 'free' | 'basic' | 'pro'

// プラン制限設定
export const PLAN_LIMITS = {
  free: {
    ai: 5,      // AI使用回数/月
    ocr: 5,     // OCR使用回数/月
    si: 2,      // SI登録件数
  },
  basic: {
    ai: 50,
    ocr: 50,
    si: 20,
  },
  pro: {
    ai: Infinity,
    ocr: Infinity,
    si: Infinity,
  },
} as const

// ===== ストア管理 =====

/**
 * リクエストからストアIDを取得
 */
export async function getStoreId(request: Request): Promise<string> {
  try {
    const { session } = await authenticate.admin(request)
    return session.shop // "example.myshopify.com"
  } catch (error) {
    throw new Error('Store authentication failed')
  }
}

/**
 * ストア情報を取得
 */
export async function getStoreInfo(storeId: string) {
  const plan = await getUserPlan(storeId)
  const usage = await getUserUsage(storeId)
  
  return {
    id: storeId,
    domain: storeId,
    plan,
    usage,
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
  return plan ?? 'free' // デフォルトはfree
}

// ===== 使用回数管理 =====

/**
 * 現在の年月を取得 (YYYYMM形式)
 */
function getCurrentMonth(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${year}${month}`
}

/**
 * AI使用回数をチェック＆インクリメント
 */
export async function checkAndIncrementAI(userId: string): Promise<void> {
  const month = getCurrentMonth()
  const aiKey = `ai:${userId}:${month}`
  
  // 現在の使用回数を取得
  const currentCount = (await redis.get<number>(aiKey)) ?? 0
  
  // ユーザーのプランを取得
  const plan = await getUserPlan(userId)
  const limit = PLAN_LIMITS[plan].ai
  
  // 制限チェック
  if (currentCount >= limit) {
    throw new Error(`AI使用回数の月間上限（${limit}回）に達しました。プランをアップグレードしてください。`)
  }
  
  // インクリメント
  await redis.incr(aiKey)
}

/**
 * OCR使用回数をチェック＆インクリメント
 */
export async function checkAndIncrementOCR(userId: string): Promise<void> {
  const month = getCurrentMonth()
  const ocrKey = `ocr:${userId}:${month}`
  
  // 現在の使用回数を取得
  const currentCount = (await redis.get<number>(ocrKey)) ?? 0
  
  // ユーザーのプランを取得
  const plan = await getUserPlan(userId)
  const limit = PLAN_LIMITS[plan].ocr
  
  // 制限チェック
  if (currentCount >= limit) {
    throw new Error(`OCR使用回数の月間上限（${limit}回）に達しました。プランをアップグレードしてください。`)
  }
  
  // インクリメント
  await redis.incr(ocrKey)
}

/**
 * リクエストからストアIDを取得してAI制限チェック
 */
export async function checkAndIncrementAIFromRequest(request: Request): Promise<void> {
  const storeId = await getStoreId(request)
  await checkAndIncrementAI(storeId)
}

/**
 * リクエストからストアIDを取得してOCR制限チェック
 */
export async function checkAndIncrementOCRFromRequest(request: Request): Promise<void> {
  const storeId = await getStoreId(request)
  await checkAndIncrementOCR(storeId)
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
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/shipments?shop_id=eq.${encodeURIComponent(userId)}&select=count`, {
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY!,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY!}`,
        'Content-Type': 'application/json',
        'Prefer': 'count=exact'
      }
    })
    
    if (response.ok) {
      const contentRange = response.headers.get('content-range')
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/)
        siCount = match ? parseInt(match[1], 10) : 0
      } else {
        const data = await response.json()
        siCount = Array.isArray(data) ? data.length : 0
      }
    }
  } catch (error) {
    console.error('SI件数取得エラー:', error)
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

/**
 * リクエストからストアIDを取得して使用状況を取得
 */
export async function getUserUsageFromRequest(request: Request) {
  const storeId = await getStoreId(request)
  return await getUserUsage(storeId)
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
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/shipments?shop_id=eq.${encodeURIComponent(userId)}&select=count`, {
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY!,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY!}`,
        'Content-Type': 'application/json',
        'Prefer': 'count=exact'
      }
    })
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Supabase query failed: ${response.status} ${errorText}`)
    }
    const contentRange = response.headers.get('content-range')
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)$/)
      currentCount = match ? parseInt(match[1], 10) : 0
    } else {
      const data = await response.json()
      currentCount = Array.isArray(data) ? data.length : 0
    }
    if (currentCount >= limit) {
      throw new Error(`SI登録件数の上限（${limit}件）に達しました。プランをアップグレードしてください。`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('SI登録件数の上限')) {
      throw error
    }
     // それ以外は詳細を含めてthrow
     const detail = error instanceof Error ? error.message : String(error)
     throw new Error(`SI登録件数の確認中にエラーが発生しました。詳細: ${detail}`)
  }
}

/**
 * リクエストからストアIDを取得してSI制限チェック
 */
export async function checkSILimitFromRequest(request: Request): Promise<void> {
  const storeId = await getStoreId(request)
  await checkSILimit(storeId)
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
// ===== テスト用関数 =====

/**
 * Redis接続テスト
 */
export async function testRedis(): Promise<void> {
  await redis.set('test', 'Hello Upstash!')
  const result = await redis.get('test')
  console.log('Redis test result:', result)
}

/**
 * プラン設定テスト
 */
export async function testPlanSetup(): Promise<void> {
  const testUserId = 'test-shop.myshopify.com'
  
  // プラン設定
  await setUserPlan(testUserId, 'basic')
  console.log('Plan set to basic')
  
  // プラン確認
  const plan = await getUserPlan(testUserId)
  console.log('Current plan:', plan)
  
  // 使用状況確認
  const usage = await getUserUsage(testUserId)
  console.log('Usage:', usage)
}


/**
 * 制限テスト（AI）
 */
export async function testAILimit(): Promise<void> {
  const testUserId = 'test-shop.myshopify.com'
  
  try {
    // freeプランに設定（5回制限）
    await setUserPlan(testUserId, 'free')
    
    // 6回実行して制限に引っかかることを確認
    for (let i = 1; i <= 6; i++) {
      console.log(`AI使用 ${i}回目...`)
      await checkAndIncrementAI(testUserId)
      console.log(`✅ AI使用 ${i}回目 成功`)
    }
  } catch (error) {
    console.log('❌ 制限に達しました:', getErrorMessage(error))
  }
}
