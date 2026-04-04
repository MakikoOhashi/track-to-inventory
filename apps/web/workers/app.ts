import { createRequestHandler } from "react-router";

type CloudflareLoadContext = {
  cloudflare: {
    env: Env;
    ctx: ExecutionContext;
    cf: Request["cf"];
  };
};

type ServerBuild = typeof import("../build/server/index.js");
type AssetBinding = {
  fetch(request: Request): Promise<Response>;
};

let buildPromise: Promise<ServerBuild> | undefined;
let requestHandlerPromise: Promise<ReturnType<typeof createRequestHandler>> | undefined;

function applyCloudflareEnvToProcess(env: Env) {
  const processEnv = process.env as Record<string, string | undefined>;
  const envKeys = [
    "SHOPIFY_API_KEY",
    "SHOPIFY_API_SECRET",
    "SHOPIFY_APP_URL",
    "SCOPES",
    "SHOPIFY_SESSION_STORAGE",
    "OCR_API_BASE_URL",
    "SYNC_API_BASE_URL",
    "OCR_API_SHARED_SECRET",
    "SYNC_API_SHARED_SECRET",
    "DATABASE_URL",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_KEY",
    "GEMINI_API_KEY",
    "RESEND_API_KEY",
    "RECAPTCHA_SITE_KEY",
    "RECAPTCHA_SECRET_KEY",
  ] as const;

  for (const key of envKeys) {
    const value = env[key];
    if (typeof value === "string") {
      processEnv[key] = value;
    }
  }

  processEnv.NODE_ENV ??= "production";
}

async function getRequestHandler(env: Env) {
  applyCloudflareEnvToProcess(env);

  buildPromise ??= import("../build/server/index.js");
  requestHandlerPromise ??= buildPromise.then((build) =>
    createRequestHandler(build, process.env.NODE_ENV === "production" ? "production" : "development"),
  );

  return requestHandlerPromise;
}

function shouldServeFromAssets(request: Request) {
  const { pathname } = new URL(request.url);

  return (
    pathname.startsWith("/assets/") ||
    pathname === "/favicon.ico" ||
    pathname === "/instruction_demo.png" ||
    pathname === "/robots.txt"
  );
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (shouldServeFromAssets(request)) {
      const assetResponse = await (env.ASSETS as AssetBinding).fetch(request);

      if (assetResponse.status !== 404) {
        return assetResponse;
      }

      return new Response(`Asset not found: ${new URL(request.url).pathname}`, {
        status: 404,
      });
    }

    const handleRequest = await getRequestHandler(env);
    const loadContext: CloudflareLoadContext = {
      cloudflare: {
        env,
        ctx,
        cf: request.cf,
      },
    };

    return handleRequest(request, loadContext);
  },
} satisfies ExportedHandler<Env>;
