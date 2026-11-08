import { describe, expect, it } from "vitest";
import { csvPreview } from "../src/media.js";

describe("csvPreview", () => {
  it("strips BOM and caps rows", () => {
    const rows = Array.from({ length: 250 }, (_, i) => `${i},value${i}`).join("\n");
    const preview = csvPreview(`\uFEFF${rows}`);
    const lines = preview.split("\n");
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe("0,value0");
    expect(preview.startsWith("\uFEFF")).toBe(false);
  });
});
