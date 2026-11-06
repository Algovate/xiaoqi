import { describe, expect, it } from "vitest";
import { chunkReply, sanitizeReply } from "../src/format.js";

describe("sanitizeReply", () => {
  it("removes markdown headings and bold markers", () => {
    expect(sanitizeReply("## 结论\n**重点**：可以")).toBe("结论\n重点：可以");
  });

  it("converts list markers", () => {
    expect(sanitizeReply("- a\n- b")).toBe("• a\n• b");
  });
});

describe("chunkReply", () => {
  it("keeps short text in one chunk", () => {
    expect(chunkReply("短回答")).toEqual(["短回答"]);
  });

  it("caps at three chunks and adds truncation notice", () => {
    const text = Array.from({ length: 10 }, (_, i) => `第${i}段`.repeat(200)).join("\n\n");
    const chunks = chunkReply(text);
    expect(chunks.length).toBe(3);
    expect(chunks[2]).toContain("已省略");
  });
});
