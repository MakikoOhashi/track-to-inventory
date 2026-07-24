const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Normalize a Shopify shop domain for tenant identity.
 * Returns "" when the value is not a valid *.myshopify.com domain.
 */
export function normalizeShopDomain(shop: string | null | undefined): string {
  if (typeof shop !== "string") return "";

  const normalized = shop.trim().toLowerCase();
  return SHOP_DOMAIN_PATTERN.test(normalized) ? normalized : "";
}

export function isValidShopDomain(shop: string | null | undefined): boolean {
  return normalizeShopDomain(shop).length > 0;
}
