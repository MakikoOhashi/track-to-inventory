export function isJapaneseLocale(locale: string | null | undefined) {
  return (locale || "").toLowerCase().startsWith("ja");
}

export function resolveRequestLocale(request: Request, fallback = "") {
  const url = new URL(request.url);
  const locale =
    url.searchParams.get("locale") ||
    request.headers.get("x-app-locale") ||
    fallback ||
    "";
  return locale.toLowerCase();
}

export function isJapaneseRequest(request: Request, fallback = "") {
  const locale = resolveRequestLocale(request, fallback);
  if (locale) return isJapaneseLocale(locale);
  const acceptLanguage = request.headers.get("accept-language") || "";
  return acceptLanguage.toLowerCase().includes("ja");
}

