import crypto from "crypto";

export function verifyShopifyHmac(query: Record<string, string | string[]>, secret: string): boolean {
  // hmacを取り出す
  const { hmac, ...rest } = query;
  // クエリをアルファベット順にソートし、hmac以外で連結
  const message = Object.keys(rest)
    .sort()
    .map(key => {
      const value = Array.isArray(rest[key]) ? rest[key][0] : rest[key];
      return `${key}=${value}`;
    })
    .join('&');
  const hash = crypto.createHmac('sha256', secret).update(message).digest('hex');
  // 比較（大文字小文字を合わせる）
  return hash === hmac;
}