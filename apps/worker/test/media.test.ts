import { describe, expect, it } from "vitest";
import { csvPreview, resolveFileExtension } from "../src/media.js";

describe("resolveFileExtension", () => {
  it("infers text formats from the file name when magic is unknown", () => {
    expect(resolveFileExtension("bin", "CURRENT-STATUS.md")).toBe("md");
    expect(resolveFileExtension("bin", "notes.txt")).toBe("txt");
    expect(resolveFileExtension("bin", "data.csv")).toBe("csv");
    expect(resolveFileExtension("bin", "archive.bin")).toBe("bin");
  });
});

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
