import fsp from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import type { AppConfig, Database, Logger, MessageRow, UserRow } from "@xiaoqi/core";
import { buildContext } from "./context.js";
import { searchKnowledge } from "./kb.js";
import { chat, type ChatMessage, type ChatResult, type ToolDefinition } from "./llm.js";
import { extractAttachments } from "./media.js";
import { sanitizeReply } from "./format.js";
import { chatWithTools } from "./agent.js";
import { chartSpecFromTool, RENDER_CHART_TOOL, renderChartPng } from "./chart.js";
import {
  executeWebSearchTool,
  formatSourceList,
  isWebSearchEnabled,
  type WebSearchSession,
  WEB_SEARCH_TOOL,
  WEB_SEARCH_TOOL_CHOICE,
} from "./web-search.js";

export interface AnswerResult {
  text: string;
  errorCode: string | null;
  promptTokens: number;
  completionTokens: number;
  model: string;
  media?: { path: string; mime: string; filename: string };
}

export interface AnswerOptions {
  query?: string;
  forceSearch?: boolean;
}

export async function generateAnswer(
  deps: { config: AppConfig; db: Database; pool: Pool; logger: Logger },
  msg: MessageRow,
  runId: string,
  traceId: string | null,
  _user: UserRow | null,
  opts: AnswerOptions = {},
): Promise<AnswerResult> {
  const { config, db, pool, logger } = deps;
  const forceSearch = Boolean(opts.forceSearch);

  if (forceSearch && !isWebSearchEnabled(config)) {
    logger.warn({ runId }, "web search requested but disabled");
    return {
      text: "联网搜索未开启：在 .env 设置 WEB_SEARCH_ENABLED=true，确认 LLM_API_KEY 已配置后重启 worker。",
      errorCode: "WEB_SEARCH_DISABLED",
      promptTokens: 0,
      completionTokens: 0,
      model: "search",
    };
  }

  try {
    const attachmentText = await extractAttachments(db, config, msg);
    const currentQuestion =
      opts.query?.trim() || msg.text?.trim() || (attachmentText ? "请分析我发的附件" : "（非文本消息）");

    let knowledgeText = "";
    try {
      const hits = await searchKnowledge(pool, currentQuestion, 5);
      knowledgeText = hits.map((h) => `[${h.title}]\n${h.content}`).join("\n\n");
    } catch (err) {
      logger.warn({ err }, "knowledge search failed");
    }

    const context = await buildContext(
      db,
      msg.conversationKey,
      {
        id: msg.id,
        text: currentQuestion,
        createdAt: msg.createdAt,
        userId: msg.userId,
      },
      attachmentText,
      knowledgeText,
    );

    logger.info(
      {
        runId,
        contextMessages: context.messageCount,
        attachmentChars: attachmentText.length,
        knowledgeChars: knowledgeText.length,
        forceSearch,
      },
      "calling llm",
    );

    const messages: ChatMessage[] = [
      { role: "system", content: context.system },
      { role: "user", content: context.user },
    ];
    const webSearchEnabled =
      isWebSearchEnabled(config) && (forceSearch || config.WEB_SEARCH_AUTO);
    const chartEnabled = config.MEDIA_OUTBOUND_ENABLED;
    const searchSession: WebSearchSession = { sources: [], nextIndex: 1 };
    const chartSession: { media?: { path: string; mime: string; filename: string } } = {};
    const tools: ToolDefinition[] = [];
    if (webSearchEnabled) tools.push(WEB_SEARCH_TOOL);
    if (chartEnabled) tools.push(RENDER_CHART_TOOL);

    let result: ChatResult;
    try {
      result =
        tools.length > 0
          ? await chatWithTools(
              config,
              messages,
              tools,
              async (name, args) => {
                if (name === "web_search") {
                  if (!webSearchEnabled) return "联网搜索未启用。";
                  return executeWebSearchTool(
                    searchSession,
                    { config, logger, runId, question: currentQuestion },
                    args,
                  );
                }
                if (name === "render_chart") {
                  if (!chartEnabled) return "图片发送未启用。";
                  const spec = chartSpecFromTool(args);
                  if (!spec) return "图表参数不合法：需要 1-12 个标签和数值，且数值非负。";
                  try {
                    const outputDir = path.resolve(config.MEDIA_DIR, "outbound");
                    const file = await renderChartPng(spec, outputDir);
                    if (file.size > config.MEDIA_OUTBOUND_MAX_BYTES) {
                      await fsp.unlink(file.path).catch(() => undefined);
                      return "图表太大，减少数据点再试。";
                    }
                    if (chartSession.media) {
                      await fsp.unlink(chartSession.media.path).catch(() => undefined);
                    }
                    chartSession.media = {
                      path: file.path,
                      mime: file.mime,
                      filename: path.basename(file.path),
                    };
                    return `图表已生成：${spec.title}。请用一句话说明图表内容；图片会随后发送。`;
                  } catch (err) {
                    logger.warn({ err, runId }, "chart render failed");
                    return `图表生成失败：${err instanceof Error ? err.message : String(err)}`;
                  }
                }
                return `未知工具：${name}`;
              },
              {
                firstToolChoice: forceSearch ? WEB_SEARCH_TOOL_CHOICE : "auto",
              },
            )
          : await chat(config, messages);
    } catch (err) {
      if (tools.length === 0 || forceSearch) throw err;
      logger.warn({ err, runId }, "tool loop failed; retrying without tools");
      result = await chat(config, messages);
    }

    logger.info(
      {
        runId,
        toolCalls: "toolCallCount" in result ? result.toolCallCount : 0,
        rounds: "rounds" in result ? result.rounds : 1,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      },
      "llm completed",
    );

    let text = sanitizeReply(result.content);
    if (searchSession.sources.length > 0 && !/https?:\/\//i.test(text)) {
      text += `\n\n来源：\n${formatSourceList(searchSession.sources)}`;
    }

    return {
      text,
      errorCode: null,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      model: result.model,
      media: chartSession.media,
    };
  } catch (err) {
    logger.error({ err, runId }, "llm failed; sending fallback");
    return {
      text: `这次没答上来，稍后再试。（trace: ${(traceId ?? "").slice(0, 8)}）`,
      errorCode: "LLM_FAILED",
      promptTokens: 0,
      completionTokens: 0,
      model: config.LLM_MODEL,
    };
  }
}
