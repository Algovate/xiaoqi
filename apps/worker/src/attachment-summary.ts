import type { AppConfig, Logger } from "@xiaoqi/core";
import { chat } from "./llm.js";

const SUMMARY_SYSTEM = `你是文档摘要器。只依据给定片段，保留事实、数字、日期、决策、待办和风险；不编造。用中文列 3-6 条要点，最多 400 字，不要寒暄。`;
const MAX_CHUNK_CHARS = 30_000;
const MIN_CHUNK_CHARS = 8_000;
const FALLBACK_CHARS = 16_000;
const CONCURRENCY = 3;

export interface AttachmentDigest {
  text: string;
  promptTokens: number;
  completionTokens: number;
  chunks: number;
}

export function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of text.split("\n")) {
    if (line.length > maxChars) {
      flush();
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars));
      }
      continue;
    }
    if (current.length + line.length + 1 > maxChars) flush();
    current = current ? `${current}\n${line}` : line;
  }
  flush();
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

export async function digestAttachment(
  config: AppConfig,
  text: string,
  logger?: Logger,
  runId?: string,
): Promise<AttachmentDigest> {
  if (!config.ATTACHMENT_SUMMARY_ENABLED || text.length <= config.ATTACHMENT_SUMMARY_THRESHOLD_CHARS) {
    return { text, promptTokens: 0, completionTokens: 0, chunks: 0 };
  }

  const maxChunks = config.ATTACHMENT_SUMMARY_MAX_CHUNKS;
  const chunkChars = Math.min(
    MAX_CHUNK_CHARS,
    Math.max(MIN_CHUNK_CHARS, Math.ceil(text.length / maxChunks)),
  );
  const allChunks = chunkText(text, chunkChars);
  const chunks = allChunks.slice(0, maxChunks);

  const results = await mapLimit(chunks, CONCURRENCY, async (chunk, index) => {
    try {
      const result = await chat(
        config,
        [
          { role: "system", content: SUMMARY_SYSTEM },
          {
            role: "user",
            content: `片段 ${index + 1}/${chunks.length}\n\n${chunk}`,
          },
        ],
        {
          temperature: 0.2,
          maxTokens: 500,
          timeoutMs: Math.min(config.LLM_TIMEOUT_MS, 60_000),
        },
      );
      return {
        text: result.content.trim(),
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      };
    } catch (err) {
      logger?.warn({ err, runId, chunk: index + 1 }, "attachment chunk summary failed");
      return { text: "", promptTokens: 0, completionTokens: 0 };
    }
  });

  const summaries = results.map((r) => r.text).filter(Boolean);
  if (summaries.length === 0) {
    return {
      text: clip(text),
      promptTokens: 0,
      completionTokens: 0,
      chunks: chunks.length,
    };
  }

  const promptTokens = results.reduce((sum, r) => sum + r.promptTokens, 0);
  const completionTokens = results.reduce((sum, r) => sum + r.completionTokens, 0);
  const truncated = allChunks.length > chunks.length;
  const digest = [
    "[长文档分块摘要]",
    ...summaries.map((summary, index) => `## 片段 ${index + 1}\n${summary}`),
    `[原文 ${text.length} 字符，分 ${chunks.length} 段摘要${truncated ? "，仅覆盖前部" : ""}]`,
  ].join("\n\n");

  return { text: digest, promptTokens, completionTokens, chunks: chunks.length };
}

function clip(text: string): string {
  if (text.length <= FALLBACK_CHARS) return text;
  return `${text.slice(0, FALLBACK_CHARS)}\n[内容较长，已截断]`;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}
