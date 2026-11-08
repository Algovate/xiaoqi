import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractCodeBlocks, removeCodeBlocks, writeCodeFile } from "../src/code.js";

describe("code blocks", () => {
  it("extracts and removes fenced code", () => {
    const text = "说明：\n\n```python\ndef fib(n):\n    return n\n```\n\n完。";
    const blocks = extractCodeBlocks(text);
    expect(blocks).toEqual([{ language: "python", code: "def fib(n):\n    return n" }]);
    expect(removeCodeBlocks(text)).toBe("说明：\n\n完。");
  });

  it("writes a language-specific file and handles mixed languages", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xiaoqi-code-"));
    try {
      const py = await writeCodeFile(
        [{ language: "python", code: "print(1)" }],
        dir,
        10_000,
      );
      expect(py.filename.endsWith(".py")).toBe(true);
      expect(py.mime).toBe("text/x-python");
      expect(await fsp.readFile(py.path, "utf8")).toBe("print(1)\n");

      const mixed = await writeCodeFile(
        [
          { language: "python", code: "print(1)" },
          { language: "sql", code: "select 1;" },
        ],
        dir,
        10_000,
      );
      expect(mixed.filename.endsWith(".txt")).toBe(true);
      expect(await fsp.readFile(mixed.path, "utf8")).toContain("block 2: sql");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
