const SUPPORTED_LOCALES = ["ja", "en"] as const;

export function normalizeLocale(value?: string | null): string {
  if (!value) return "ja";

  const lower = value.toLowerCase();
  if (SUPPORTED_LOCALES.some((locale) => lower.startsWith(locale))) {
    return lower.startsWith("en") ? "en" : "ja";
  }

  return "ja";
}

export function makeLocaleCookie(locale: string): string {
  const normalized = normalizeLocale(locale);
  return `i18n=${encodeURIComponent(normalized)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
