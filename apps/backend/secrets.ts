/**
 * Encryption for third-party credentials stored in the database (Slack webhook
 * URLs today, GitHub tokens next). AES-256-GCM: the tag detects tampering, so a
 * row edited in the database fails to decrypt instead of being trusted.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_HEX = process.env.INTEGRATION_KEY;
const key = KEY_HEX && /^[0-9a-f]{64}$/i.test(KEY_HEX) ? Buffer.from(KEY_HEX, "hex") : null;

if (!key) {
  console.warn(
    "INTEGRATION_KEY not set (or not 64 hex chars) — integration routes answer 503. " +
      "Generate one with: bun -e \"console.log(crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-',''))\"",
  );
}

export const encryptionAvailable = key !== null;

/** iv.tag.ciphertext, all base64url. */
export function encryptSecret(plaintext: string): string {
  if (!key) throw new Error("INTEGRATION_KEY is not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString("base64url")).join(".");
}

/** Throws if the key is wrong or the stored value was tampered with. */
export function decryptSecret(stored: string): string {
  if (!key) throw new Error("INTEGRATION_KEY is not configured");
  const [iv, tag, ciphertext] = stored.split(".");
  if (!iv || !tag || !ciphertext) throw new Error("Stored secret is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
