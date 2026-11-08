import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildHtmlDocument, writeHtmlFile } from "../src/html.js";

describe("buildHtmlDocument", () => {
  it("wraps fragments and injects a restrictive CSP", () => {
    const html = buildHtmlDocument("<button>+1</button><script>document.title='x'</script>", "计数器");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>计数器</title>");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("<button>+1</button>");
  });

  it("removes an existing CSP before adding its own", () => {
    const html = buildHtmlDocument(
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><title>T</title></head><body></body></html>',
    );
    expect(html.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(html).toContain("connect-src 'none'");
  });

  it("rejects empty HTML", () => {
    expect(() => buildHtmlDocument("  ")).toThrow("HTML 为空");
  });
});

describe("writeHtmlFile", () => {
  it("writes a text/html file", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xiaoqi-html-"));
    try {
      const file = await writeHtmlFile("<!doctype html><html><body>ok</body></html>", dir);
      expect(file.mime).toBe("text/html");
      expect(file.filename.endsWith(".html")).toBe(true);
      expect(await fsp.readFile(file.path, "utf8")).toContain("<body>ok</body>");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
