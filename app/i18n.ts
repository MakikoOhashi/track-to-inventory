import { RemixI18Next } from "remix-i18next/server";
import { createCookie } from "@remix-run/node";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export const i18nCookie = createCookie("i18n", {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  maxAge: 60 * 60 * 24 * 365,
});

export const i18n = new RemixI18Next({
  detection: {
    cookie: i18nCookie,
    supportedLanguages: ["ja", "en"],
    fallbackLanguage: "ja",
  },
  i18next: {
    fallbackLng: "ja",
    supportedLngs: ["ja", "en"],
  },
  backend: {
    loadPath: resolve(__dirname, "./locales/{{lng}}/{{ns}}.json"),
  },
});

export default i18n;