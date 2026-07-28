import { createHash } from "node:crypto";
import type { Session } from "@shopify/shopify-api";
import {
  decryptUtf8,
  encryptUtf8,
  type EncryptedBlob,
} from "~/lib/tokenEncryption.server";

const SECRET_ENTRY_KEYS = new Set(["accessToken", "refreshToken"]);

export type ShopifySessionSecrets = {
  accessToken: string;
  refreshToken?: string;
};

export function withoutSessionSecrets(
  entries: [string, string | number | boolean][],
): [string, string | number | boolean][] {
  return entries.filter(([key]) => !SECRET_ENTRY_KEYS.has(key));
}

export function sessionSecretsFromSession(
  session: Session,
): ShopifySessionSecrets {
  if (!session.accessToken) {
    throw new Error("Shopify session access token is missing");
  }
  return {
    accessToken: session.accessToken,
    ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
  };
}

export async function encryptSessionSecrets(session: Session): Promise<string> {
  const encrypted = await encryptUtf8(
    JSON.stringify(sessionSecretsFromSession(session)),
  );
  return JSON.stringify(encrypted);
}

export async function decryptSessionSecrets(
  ciphertext: string,
): Promise<ShopifySessionSecrets> {
  let blob: EncryptedBlob;
  try {
    blob = JSON.parse(ciphertext) as EncryptedBlob;
  } catch {
    throw new Error("Invalid Shopify session ciphertext");
  }
  const plaintext = await decryptUtf8(blob);
  let secrets: ShopifySessionSecrets;
  try {
    secrets = JSON.parse(plaintext) as ShopifySessionSecrets;
  } catch {
    throw new Error("Invalid Shopify session secret payload");
  }
  if (!secrets.accessToken || typeof secrets.accessToken !== "string") {
    throw new Error("Shopify session ciphertext has no access token");
  }
  if (
    secrets.refreshToken !== undefined &&
    typeof secrets.refreshToken !== "string"
  ) {
    throw new Error("Shopify session ciphertext has invalid refresh token");
  }
  return secrets;
}

export function sessionTokenFingerprint(session: Session): string {
  const secrets = sessionSecretsFromSession(session);
  return createHash("sha256")
    .update(secrets.accessToken)
    .update("\0")
    .update(secrets.refreshToken ?? "")
    .digest("hex");
}

export function entriesWithSessionSecrets(
  entries: [string, string | number | boolean][],
  secrets: ShopifySessionSecrets,
): [string, string | number | boolean][] {
  return [
    ...withoutSessionSecrets(entries),
    ["accessToken", secrets.accessToken],
    ...(secrets.refreshToken
      ? ([["refreshToken", secrets.refreshToken]] as [
          string,
          string | number | boolean,
        ][])
      : []),
  ];
}
