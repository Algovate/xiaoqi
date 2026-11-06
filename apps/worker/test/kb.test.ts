import { describe, expect, it } from "vitest";
import { chunkText, tokenize } from "../src/kb.js";

describe("tokenize", () => {
  it("creates Chinese bigrams and English words", () => {
    const tokens = tokenize("付款条款 Payment");
    expect(tokens).toContain("付款");
    expect(tokens).toContain("款条");
    expect(tokens).toContain("payment");
  });
});

describe("chunkText", () => {
  it("chunks long text with overlap", () => {
    const text = "这是第一段。".repeat(300);
    const chunks = chunkText(text, 120, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 130)).toBe(true);
  });
});
