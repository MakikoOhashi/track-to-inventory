/**
 * AES-256-GCM helpers for Notion tokens at rest in Redis.
 * Key: Worker Secret TOKEN_ENCRYPTION_KEY (32 raw bytes, or base64 of 32 bytes).
 */

function getKeyBytes(): Uint8Array {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw || !raw.trim()) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  }
  const trimmed = raw.trim();
  try {
    const fromB64 = Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0));
    if (fromB64.length === 32) return fromB64;
  } catch {
    // fall through
  }
  const enc = new TextEncoder().encode(trimmed);
  if (enc.length === 32) return enc;
  throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (raw or base64)");
}

async function importKey(): Promise<CryptoKey> {
  const keyBytes = getKeyBytes();
  const keyCopy = new Uint8Array(keyBytes.byteLength);
  keyCopy.set(keyBytes);
  return crypto.subtle.importKey(
    "raw",
    keyCopy,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export type EncryptedBlob = {
  v: 1;
  iv: string;
  ciphertext: string;
};

export async function encryptUtf8(plaintext: string): Promise<EncryptedBlob> {
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    v: 1,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(cipherBuf)),
  };
}

export async function decryptUtf8(blob: EncryptedBlob): Promise<string> {
  if (blob.v !== 1 || !blob.iv || !blob.ciphertext) {
    throw new Error("Invalid ciphertext blob");
  }
  const key = await importKey();
  const iv = base64ToBytes(blob.iv);
  const ciphertext = base64ToBytes(blob.ciphertext);
  const ivCopy = new Uint8Array(iv.byteLength);
  ivCopy.set(iv);
  const ctCopy = new Uint8Array(ciphertext.byteLength);
  ctCopy.set(ciphertext);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivCopy },
    key,
    ctCopy,
  );
  return new TextDecoder().decode(plainBuf);
}

export function isTokenEncryptionConfigured(): boolean {
  try {
    getKeyBytes();
    return true;
  } catch {
    return false;
  }
}
