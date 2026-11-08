import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@xiaoqi/core";

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));

vi.mock("../src/llm.js", () => ({ chat: chatMock }));

const { chunkText, digestAttachment } = await import("../src/attachment-summary.js");

function configFor(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ATTACHMENT_SUMMARY_ENABLED: true,
    ATTACHMENT_SUMMARY_THRESHOLD_CHARS: 100,
    ATTACHMENT_SUMMARY_MAX_CHUNKS: 3,
    LLM_TIMEOUT_MS: 1_000,
    ...overrides,
  } as unknown as AppConfig;
}

beforeEach(() => {
  chatMock.mockReset();
  chatMock.mockResolvedValue({
    content: "要点",
    promptTokens: 10,
    completionTokens: 5,
    model: "test",
    finishReason: "stop",
    toolCalls: [],
  });
});

describe("chunkText", () => {
  it("splits by lines and hard-splits oversized lines", () => {
    const chunks = chunkText("aaa\nbbb\ncccccccccc", 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n").replace(/\n/g, "")).toBe("aaabbbcccccccccc");
  });
});

describe("digestAttachment", () => {
  it("summarizes long text in bounded chunks", async () => {
    const text = "line\n".repeat(6_000);
    const digest = await digestAttachment(configFor(), text);
    expect(chatMock).toHaveBeenCalledTimes(3);
    expect(digest.chunks).toBe(3);
    expect(digest.promptTokens).toBe(30);
    expect(digest.completionTokens).toBe(15);
    expect(digest.text).toContain("长文档分块摘要");
    expect(digest.text).toContain("要点");
  });

  it("returns short text unchanged without calling the model", async () => {
    const digest = await digestAttachment(configFor(), "short");
    expect(chatMock).not.toHaveBeenCalled();
    expect(digest.text).toBe("short");
  });

  it("does nothing when summarization is disabled", async () => {
    const text = "x".repeat(200);
    const digest = await digestAttachment(
      configFor({ ATTACHMENT_SUMMARY_ENABLED: false }),
      text,
    );
    expect(chatMock).not.toHaveBeenCalled();
    expect(digest.text).toBe(text);
  });
});
