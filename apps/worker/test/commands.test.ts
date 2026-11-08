import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getSearchQuery, handleCommand, parseCommand } from "../src/commands.js";
import { helpText, isBudgetExempt, isKnownCommand } from "../src/command-registry.js";
import { normalizeAesKey } from "../src/media.js";

describe("parseCommand", () => {
  it("parses help", () => {
    expect(parseCommand("/help")).toEqual({ name: "help", args: "", raw: "/help" });
  });

  it("is case-insensitive and keeps args", () => {
    expect(parseCommand("/Summary 今天")).toEqual({ name: "summary", args: "今天", raw: "/Summary 今天" });
  });

  it("ignores normal text", () => {
    expect(parseCommand("你好")).toBeNull();
  });

  it("normalizes a full-width slash", () => {
    expect(parseCommand("／help all")).toEqual({ name: "help", args: "all", raw: "/help all" });
  });
});

describe("command registry", () => {
  it("exposes a compact help and an all-commands help", () => {
    const core = helpText();
    expect(core).toContain("/summary");
    expect(core).toContain("/help all");
    expect(core).not.toContain("/search");
    expect(helpText("all")).toContain("/search");
    expect(helpText("all")).toContain("/codex help");
    expect(helpText("chart")).toContain("/chart bar");
    expect(helpText("nope")).toContain("没有 /nope");
  });

  it("centralizes budget exemptions and known commands", () => {
    expect(isKnownCommand("summary")).toBe(true);
    expect(isKnownCommand("nope")).toBe(false);
    expect(isBudgetExempt("summary")).toBe(false);
    expect(isBudgetExempt("chart")).toBe(true);
    expect(isBudgetExempt(undefined)).toBe(false);
  });

  it("renders help through the command handler", async () => {
    const text = await handleCommand(
      { db: {} as never, config: {} as never },
      { id: 1, senderId: "u" } as never,
      null,
      { name: "help", args: "all", raw: "/help all" },
    );
    expect(text).toContain("/search");
  });
});

describe("getSearchQuery", () => {
  it("returns the query for /search", () => {
    expect(getSearchQuery(parseCommand("/search 今天上海天气"))).toBe("今天上海天气");
  });

  it("returns null for bare or unrelated commands", () => {
    expect(getSearchQuery(parseCommand("/search"))).toBeNull();
    expect(getSearchQuery(parseCommand("/help"))).toBeNull();
    expect(getSearchQuery(null)).toBeNull();
  });
});

describe("handleCommand /export", () => {
  it("defaults to CSV when no argument is given", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xiaoqi-export-"));
    try {
      const rows = [
        { createdAt: new Date("2026-11-08T15:00:00Z"), direction: "in", itemType: "text", text: "hi" },
      ];
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => rows,
              }),
            }),
          }),
        }),
      };
      const effects: { file?: { path: string; mime: string; filename: string } } = {};
      const text = await handleCommand(
        {
          db: db as never,
          config: {
            MEDIA_OUTBOUND_ENABLED: true,
            MEDIA_OUTBOUND_MAX_BYTES: 5_000_000,
            MEDIA_DIR: dir,
          } as never,
        },
        { id: 1, conversationKey: "dm:test" } as never,
        null,
        { name: "export", args: "", raw: "/export" },
        effects,
      );
      expect(text).toContain("已导出");
      expect(effects.file?.mime).toBe("text/csv");
      await expect(fsp.stat(effects.file!.path)).resolves.toBeTruthy();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("normalizeAesKey", () => {
  const hex = "c90e0fb9faebcc500b63e18a1652e5e5";

  it("decodes base64-of-hex file key", () => {
    const raw = {
      type: 4,
      file_item: { media: { aes_key: Buffer.from(hex, "utf8").toString("base64") } },
    };
    expect(normalizeAesKey("file", raw)?.toString("hex")).toBe(hex);
  });

  it("decodes image hex key", () => {
    const raw = { type: 2, image_item: { aeskey: hex } };
    expect(normalizeAesKey("image", raw)?.toString("hex")).toBe(hex);
  });
});
