import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, MessageRow } from "@xiaoqi/core";
import { handleCommand } from "../src/commands.js";
import { renderMermaidPng } from "../src/mermaid.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fake-png"),
]);

function configFor(dir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    MEDIA_DIR: dir,
    MEDIA_OUTBOUND_ENABLED: true,
    MEDIA_OUTBOUND_MAX_BYTES: 5_000_000,
    MERMAID_ENABLED: true,
    MERMAID_RENDER_BASE_URL: "https://mermaid.test/",
    MERMAID_TIMEOUT_MS: 1_000,
    ...overrides,
  } as unknown as AppConfig;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderMermaidPng", () => {
  it("calls mermaid.ink with base64url code and stores the image", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xiaoqi-mermaid-"));
    try {
      const code = "graph LR\n  A[用户] --> B[网关]";
      const file = await renderMermaidPng(configFor(dir), code, dir);

      expect(file.mime).toBe("image/png");
      expect(file.size).toBe(PNG.length);
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain("https://mermaid.test/img/");
      expect(url).toContain("bgColor=white");
      expect(url).toContain("type=png");
      expect(url).toContain("width=900");
      const encoded = url.split("/img/")[1]!.split("?")[0]!;
      expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(code);

      const data = await fsp.readFile(file.path);
      expect(data.subarray(0, 8)).toEqual(PNG.subarray(0, 8));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects when disabled or when the response is not an image", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xiaoqi-mermaid-"));
    try {
      await expect(
        renderMermaidPng(configFor(dir, { MERMAID_ENABLED: false }), "graph LR", dir),
      ).rejects.toThrow("未启用");

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("<html>bad</html>", { status: 200 })),
      );
      await expect(renderMermaidPng(configFor(dir), "graph LR", dir)).rejects.toThrow(
        "不是图片",
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("handleCommand /mermaid", () => {
  it("renders a diagram and sets the media effect", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xiaoqi-mermaid-cmd-"));
    try {
      const effects: { media?: { path: string; mime: string; filename: string } } = {};
      const msg = {
        id: 1,
        accountId: "account",
        conversationKey: "dm:test",
        senderId: "wxid-test",
        userId: null,
      } as unknown as MessageRow;

      const text = await handleCommand(
        { db: {} as never, config: configFor(dir) },
        msg,
        null,
        { name: "mermaid", args: "graph LR\n  A[用户] --> B[小栖]", raw: "" },
        effects,
      );

      expect(text).toContain("Mermaid");
      expect(effects.media?.mime).toBe("image/png");
      await expect(fsp.stat(effects.media!.path)).resolves.toBeTruthy();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
