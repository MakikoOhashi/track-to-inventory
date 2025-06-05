import { createCookie } from "@remix-run/node";
import { RemixI18Next } from "remix-i18next/server";
import i18next from "i18next";
import Backend from "i18next-http-backend";

export const i18nCookie = createCookie("i18n", {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  maxAge: 60 * 60 * 24 * 365,
});

export const i18n = new RemixI18Next({
  detection: {
    cookie: i18nCookie,
    supportedLanguages: ["ja", "en"],      // ここを追加
    fallbackLanguage: "ja",                // ここを追加
  },
  i18next: {
    fallbackLng: "ja",
    supportedLngs: ["ja", "en"],
    backend: {
      loadPath: "./public/locales/{{lng}}/translation.json",
    },
  },
  backend: Backend,
});