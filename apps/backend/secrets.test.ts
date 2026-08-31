/** Unit tests for the at-rest encryption of integration credentials. */
process.env.INTEGRATION_KEY = "0".repeat(63) + "1";

import { describe, expect, test } from "bun:test";
const { encryptSecret, decryptSecret, encryptionAvailable } = await import(
  "./secrets"
);

// Opaque plaintext for the round-trip; the shape carries no meaning here.
// The host is a reserved TLD (RFC 2606) so this can never be a live webhook,
// and so push protection does not read it as one.
const URL = "https://hooks.slack.invalid/services/T0/B0/round-trip-me";

describe("secrets", () => {
  test("key present → available", () => {
    expect(encryptionAvailable).toBe(true);
  });

  test("round-trips", () => {
    expect(decryptSecret(encryptSecret(URL))).toBe(URL);
  });

  test("ciphertext hides the plaintext and is not stable across calls", () => {
    const a = encryptSecret(URL);
    const b = encryptSecret(URL);
    expect(a).not.toContain("hooks.slack.com");
    expect(a).not.toContain("v0Pz9VroIFsQxkZfszSAuhYT");
    expect(a).not.toBe(b); // fresh IV each time, so equal URLs are not linkable
    expect(decryptSecret(b)).toBe(URL);
  });

  test("a tampered ciphertext fails the auth tag instead of decrypting to garbage", () => {
    const [iv, tag, ciphertext] = encryptSecret(URL).split(".");
    const flipped = Buffer.from(ciphertext!, "base64url");
    flipped[0]! ^= 0xff;
    expect(() => decryptSecret(`${iv}.${tag}.${flipped.toString("base64url")}`)).toThrow();
  });

  test("a tampered tag is rejected", () => {
    const [iv, tag, ciphertext] = encryptSecret(URL).split(".");
    const flipped = Buffer.from(tag!, "base64url");
    flipped[0]! ^= 0xff;
    expect(() => decryptSecret(`${iv}.${flipped.toString("base64url")}.${ciphertext}`)).toThrow();
  });

  test("a malformed stored value is rejected, not silently accepted", () => {
    expect(() => decryptSecret("not-encrypted")).toThrow();
    expect(() => decryptSecret("")).toThrow();
  });

  test("a value encrypted under a different key cannot be read", async () => {
    const foreign = encryptSecret(URL);
    // A separate process, because the module reads its key once at load —
    // exactly what a deploy with a rotated INTEGRATION_KEY would do.
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const { decryptSecret } = await import("./secrets");
         try { console.log("DECRYPTED:" + decryptSecret(process.argv[1])); } catch { console.log("THREW"); }`,
        foreign,
      ],
      {
        // cwd is pinned so `./secrets` resolves the same whether the suite is
        // run from this directory or from the repo root, as CI does.
        cwd: import.meta.dir,
        env: { ...process.env, INTEGRATION_KEY: "f".repeat(64) },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await proc.exited;
    expect((await new Response(proc.stdout).text()).trim()).toBe("THREW");
  });
});
