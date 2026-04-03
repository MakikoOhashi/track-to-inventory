import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// 環境変数のデバッグログ
console.log('Shopify App Configuration:');
console.log('- SHOPIFY_API_KEY exists:', !!process.env.SHOPIFY_API_KEY);
console.log('- SHOPIFY_API_SECRET exists:', !!process.env.SHOPIFY_API_SECRET);
console.log('- SCOPES:', process.env.SCOPES);
console.log('- SHOPIFY_APP_URL:', process.env.SHOPIFY_APP_URL);
console.log('- SHOP_CUSTOM_DOMAIN:', process.env.SHOP_CUSTOM_DOMAIN);
console.log('- DATABASE_URL exists:', !!process.env.DATABASE_URL);

// 必須環境変数のチェック
if (!process.env.SHOPIFY_API_KEY) {
  throw new Error('SHOPIFY_API_KEY environment variable is required');
}

if (!process.env.SHOPIFY_API_SECRET) {
  throw new Error('SHOPIFY_API_SECRET environment variable is required');
}

if (!process.env.SCOPES) {
  throw new Error('SCOPES environment variable is required');
}

if (!process.env.SHOPIFY_APP_URL) {
  throw new Error('SHOPIFY_APP_URL environment variable is required');
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  apiVersion: ApiVersion.October24,
  scopes: process.env.SCOPES.split(","),
  appUrl: process.env.SHOPIFY_APP_URL,
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
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
