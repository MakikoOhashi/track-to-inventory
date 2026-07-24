import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type NotionOAuthTokenResponse = {
  access_token: string;
  token_type?: string;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string | null;
  workspace_icon?: string | null;
  duplicated_template_id?: string | null;
  owner?: { type?: string; user?: { id?: string } };
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function getNotionOAuthConfig() {
  return {
    clientId: requireEnv("NOTION_CLIENT_ID"),
    clientSecret: requireEnv("NOTION_CLIENT_SECRET"),
    redirectUri: requireEnv("NOTION_REDIRECT_URI"),
  };
}

export function isNotionOAuthConfigured(): boolean {
  return Boolean(
    process.env.NOTION_CLIENT_ID?.trim() &&
      process.env.NOTION_CLIENT_SECRET?.trim() &&
      process.env.NOTION_REDIRECT_URI?.trim(),
  );
}

/** Signed OAuth state: shop|nonce|signature */
export function createNotionOAuthState(shopId: string): string {
  const secret = process.env.NOTION_CLIENT_SECRET?.trim() || process.env.TOKEN_ENCRYPTION_KEY || "dev";
  const nonce = randomBytes(16).toString("hex");
  const payload = `${shopId}|${nonce}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}|${sig}`;
}

export function parseAndVerifyNotionOAuthState(state: string): { shopId: string; nonce: string } | null {
  const parts = state.split("|");
  if (parts.length !== 3) return null;
  const [shopId, nonce, sig] = parts;
  if (!shopId || !nonce || !sig) return null;
  const secret = process.env.NOTION_CLIENT_SECRET?.trim() || process.env.TOKEN_ENCRYPTION_KEY || "dev";
  const payload = `${shopId}|${nonce}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return { shopId, nonce };
}

export function buildNotionAuthorizeUrl(state: string): string {
  const { clientId, redirectUri } = getNotionOAuthConfig();
  const url = new URL("https://api.notion.com/v1/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeNotionCode(code: string): Promise<NotionOAuthTokenResponse> {
  const { clientId, clientSecret, redirectUri } = getNotionOAuthConfig();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message =
      (typeof json?.error_description === "string" && json.error_description) ||
      (typeof json?.message === "string" && json.message) ||
      `Notion OAuth token exchange failed (${response.status})`;
    throw new Error(message);
  }

  if (!json?.access_token || typeof json.access_token !== "string") {
    throw new Error("Notion OAuth response missing access_token");
  }

  return json as NotionOAuthTokenResponse;
}
