import { describe, expect, it } from "vitest";
import { extractText, parseJsonPreserveBigInts } from "../src/parse.js";

describe("parseJsonPreserveBigInts", () => {
  it("keeps uint64 message ids as strings", () => {
    const parsed = parseJsonPreserveBigInts(
      '{"message_id":7524313909497035000,"small":1,"nested":{"id":9007199254740993}}',
    ) as Record<string, unknown>;
    expect(parsed.message_id).toBe("7524313909497035000");
    expect(parsed.small).toBe(1);
    expect((parsed.nested as Record<string, unknown>).id).toBe("9007199254740993");
  });

  it("does not touch numbers inside strings", () => {
    const parsed = parseJsonPreserveBigInts('{"text":"id 7524313909497035000"}') as Record<string, unknown>;
    expect(parsed.text).toBe("id 7524313909497035000");
  });
});

describe("extractText", () => {
  it("combines text and placeholders", () => {
    const text = extractText({
      item_list: [
        { type: 1, text_item: { text: "你好" } },
        { type: 2, image_item: {} },
        { type: 4, file_item: { file_name: "a.pdf" } },
      ],
    });
    expect(text).toBe("你好\n[图片]\n[文件] a.pdf");
  });
});
