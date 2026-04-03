import crypto from "crypto";

export function verifyShopifyHmac(query: Record<string, string | string[]>, secret: string): boolean {
  const { hmac, ...rest } = query;
  const message = Object.keys(rest)
    .sort()
    .map(key => {
      const value = Array.isArray(rest[key]) ? rest[key][0] : rest[key];
      return `${key}=${value}`;
    })
    .join('&');
  const hash = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return typeof hmac === "string" && hash === hmac.toLowerCase();
}