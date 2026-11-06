import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto.js";

describe("secret encryption", () => {
  const key = Buffer.alloc(32, 7);

  it("round-trips", () => {
    const stored = encryptSecret("bot-token-123", key);
    expect(stored.startsWith("v1:")).toBe(true);
    expect(decryptSecret(stored, key)).toBe("bot-token-123");
  });

  it("rejects wrong key", () => {
    const stored = encryptSecret("bot-token-123", key);
    expect(() => decryptSecret(stored, Buffer.alloc(32, 8))).toThrow();
  });

  it("uses a fresh IV", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });
});
