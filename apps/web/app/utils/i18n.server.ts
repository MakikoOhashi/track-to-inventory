const SUPPORTED_LOCALES = ["ja", "en"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function normalizeLocale(value?: string | null): SupportedLocale | null {
  if (!value) return null;

  const lower = value.toLowerCase();
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("en")) return "en";

  return null;
}

function parseCookieLocale(cookieHeader?: string | null): SupportedLocale | null {
  if (!cookieHeader) return null;

  const match = cookieHeader.match(/(?:^|;\s*)i18n=([^;]+)/);
  if (!match) return null;

  return normalizeLocale(decodeURIComponent(match[1]));
}

function parseAcceptLanguage(header?: string | null): SupportedLocale | null {
  if (!header) return null;

  const preferred = header
    .split(",")
    .map((part) => part.split(";")[0]?.trim())
    .filter(Boolean);

  for (const candidate of preferred) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }

  return null;
}

export function getLocaleFromRequest(request: Request): SupportedLocale {
  const cookieLocale = parseCookieLocale(request.headers.get("Cookie"));
  if (cookieLocale) return cookieLocale;

  const acceptLocale = parseAcceptLanguage(request.headers.get("Accept-Language"));
  if (acceptLocale) return acceptLocale;

  return "ja";
}

export const i18n = {
  getLocale: getLocaleFromRequest,
};
