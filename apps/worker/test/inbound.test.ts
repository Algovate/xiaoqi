import { describe, expect, it } from "vitest";
import type { MessageRow } from "@xiaoqi/core";
import { mergeInboundBurst } from "../src/inbound.js";

function row(id: number, text: string, itemList: unknown[] = []): MessageRow {
  return {
    id,
    text,
    direction: "in",
    raw: { item_list: itemList },
    createdAt: new Date("2026-11-08T14:22:26Z"),
  } as unknown as MessageRow;
}

describe("mergeInboundBurst", () => {
  it("merges text and file items into the latest message", () => {
    const merged = mergeInboundBurst([
      row(70, "总结此文档"),
      row(71, "[文件] CURRENT-STATUS.md", [
        { type: 4, file_item: { file_name: "CURRENT-STATUS.md" } },
      ]),
    ]);
    expect(merged?.id).toBe(71);
    expect(merged?.text).toBe("总结此文档\n[文件] CURRENT-STATUS.md");
    expect((merged?.raw as { item_list: unknown[] }).item_list).toHaveLength(1);
  });

  it("returns null for an empty burst and deduplicates repeated text", () => {
    expect(mergeInboundBurst([])).toBeNull();
    const merged = mergeInboundBurst([row(1, "你好"), row(2, "你好")]);
    expect(merged?.text).toBe("你好");
  });
});
