import { describe, expect, it } from "vitest";
import { parseReminder } from "../src/time.js";

const now = new Date("2026-11-06T02:00:00.000Z"); // 2026-11-06 10:00 Asia/Shanghai, Friday

describe("parseReminder", () => {
  it("parses 明天10点", () => {
    const r = parseReminder("明天10点 交周报", now);
    expect(r?.runAt.toISOString()).toBe("2026-11-07T02:00:00.000Z");
    expect(r?.text).toBe("交周报");
  });

  it("parses 周五18:00 as today", () => {
    const r = parseReminder("周五18:00 发版检查", now);
    expect(r?.runAt.toISOString()).toBe("2026-11-06T10:00:00.000Z");
  });

  it("parses time only as tomorrow when passed", () => {
    const r = parseReminder("09:00 早起", now);
    expect(r?.runAt.toISOString()).toBe("2026-11-07T01:00:00.000Z");
  });

  it("parses relative minutes", () => {
    const r = parseReminder("30分钟后 喝水", now);
    expect(r?.runAt.toISOString()).toBe("2026-11-06T02:30:00.000Z");
  });

  it("parses month/day", () => {
    const r = parseReminder("11/12 20:00 发布", now);
    expect(r?.runAt.toISOString()).toBe("2026-11-12T12:00:00.000Z");
  });

  it("rejects past/invalid", () => {
    expect(parseReminder("昨天10点 测试", now)).toBeNull();
    expect(parseReminder("随便说说", now)).toBeNull();
  });
});
