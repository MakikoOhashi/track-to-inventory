import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import shopifySessionStorage from "./sessionStorage.server";

// 必須環境変数のチェック
if (!process.env.SHOPIFY_API_KEY) {
  throw new Error("SHOPIFY_API_KEY environment variable is required");
}

if (!process.env.SHOPIFY_API_SECRET) {
  throw new Error("SHOPIFY_API_SECRET environment variable is required");
}

if (!process.env.SCOPES) {
  throw new Error("SCOPES environment variable is required");
}

if (!process.env.SHOPIFY_APP_URL) {
  throw new Error("SHOPIFY_APP_URL environment variable is required");
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  apiVersion: ApiVersion.October24,
  scopes: process.env.SCOPES.split(","),
  appUrl: process.env.SHOPIFY_APP_URL,
  authPathPrefix: "/auth",
  sessionStorage: shopifySessionStorage,
  distribution: AppDistribution.AppStore,
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October24;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
