import { describe, expect, it } from "vitest";
import { getSearchQuery, parseCommand } from "../src/commands.js";
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
