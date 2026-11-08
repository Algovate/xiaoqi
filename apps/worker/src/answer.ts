import fsp from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import type { AppConfig, Database, Logger, MessageRow, UserRow } from "@xiaoqi/core";
import { buildContext } from "./context.js";
import { searchKnowledge } from "./kb.js";
import { chat, type ChatMessage, type ChatResult, type ToolDefinition } from "./llm.js";
import { extractAttachments, recentAttachmentText } from "./media.js";
import { digestAttachment } from "./attachment-summary.js";
import { sanitizeReply } from "./format.js";
import { chatWithTools } from "./agent.js";
import { chartSpecFromTool, RENDER_CHART_TOOL } from "./chart.js";
import { renderChartPng } from "./chart-render.js";
import { RENDER_MERMAID_TOOL, renderMermaidPng } from "./mermaid.js";
import { extractCodeBlocks, removeCodeBlocks, writeCodeFile } from "./code.js";
import { buildHtmlDocument, RENDER_HTML_TOOL, writeHtmlFile } from "./html.js";
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
  file?: { path: string; mime: string; filename: string };
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
    let attachmentText = await extractAttachments(db, config, msg);
    if (!attachmentText) {
      const recent = await recentAttachmentText(db, msg.conversationKey).catch((err) => {
        logger.warn({ err, runId }, "recent attachment lookup failed");
        return "";
      });
      if (recent) attachmentText = `[最近消息的附件内容]\n${recent}`;
    }

    let attachmentPromptTokens = 0;
    let attachmentCompletionTokens = 0;
    if (attachmentText) {
      const digest = await digestAttachment(config, attachmentText, logger, runId);
      attachmentText = digest.text;
      attachmentPromptTokens = digest.promptTokens;
      attachmentCompletionTokens = digest.completionTokens;
      if (digest.chunks > 0) {
        logger.info(
          { runId, chunks: digest.chunks, chars: digest.text.length },
          "long attachment summarized",
        );
      }
    }

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
    const mermaidEnabled = config.MERMAID_ENABLED && chartEnabled;
    const searchSession: WebSearchSession = { sources: [], nextIndex: 1 };
    const mediaSession: { media?: { path: string; mime: string; filename: string } } = {};
    const fileSession: { file?: { path: string; mime: string; filename: string } } = {};

    async function acceptMedia(file: { path: string; mime: string }): Promise<void> {
      if (mediaSession.media) {
        await fsp.unlink(mediaSession.media.path).catch(() => undefined);
      }
      mediaSession.media = {
        path: file.path,
        mime: file.mime,
        filename: path.basename(file.path),
      };
    }

    const tools: ToolDefinition[] = [];
    if (webSearchEnabled) tools.push(WEB_SEARCH_TOOL);
    if (chartEnabled) tools.push(RENDER_CHART_TOOL, RENDER_HTML_TOOL);
    if (mermaidEnabled) tools.push(RENDER_MERMAID_TOOL);

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
                    await acceptMedia(file);
                    return `图表已生成：${spec.title}。系统会先发图片，再发你的文字说明；请用一句话说明图表内容。`;
                  } catch (err) {
                    logger.warn({ err, runId }, "chart render failed");
                    return `图表生成失败：${err instanceof Error ? err.message : String(err)}`;
                  }
                }
                if (name === "render_mermaid") {
                  if (!mermaidEnabled) return "Mermaid 渲染未启用。";
                  const code = typeof args.code === "string" ? args.code : "";
                  try {
                    const outputDir = path.resolve(config.MEDIA_DIR, "outbound");
                    const file = await renderMermaidPng(config, code, outputDir);
                    await acceptMedia(file);
                    return "Mermaid 图已生成。系统会先发图片，再发你的文字说明；请用一句话说明架构或流程。";
                  } catch (err) {
                    logger.warn({ err, runId }, "mermaid render failed");
                    return `Mermaid 渲染失败：${err instanceof Error ? err.message : String(err)}`;
                  }
                }
                if (name === "render_html") {
                  if (!chartEnabled) return "媒体发送未启用。";
                  const html = typeof args.html === "string" ? args.html : "";
                  const title = typeof args.title === "string" ? args.title : undefined;
                  try {
                    const outputDir = path.resolve(config.MEDIA_DIR, "outbound");
                    const file = await writeHtmlFile(buildHtmlDocument(html, title), outputDir);
                    if (fileSession.file) {
                      await fsp.unlink(fileSession.file.path).catch(() => undefined);
                    }
                    fileSession.file = file;
                    return "交互式 HTML 已生成。系统会先发文件，再发你的文字说明；请用一句话说明怎么打开和交互，不要贴代码。";
                  } catch (err) {
                    logger.warn({ err, runId }, "html render failed");
                    return `HTML 生成失败：${err instanceof Error ? err.message : String(err)}`;
                  }
                }
                return `未知工具：${name}`;
              },
              {
                firstToolChoice: forceSearch ? WEB_SEARCH_TOOL_CHOICE : "auto",
                // HTML/代码工具参数可能很长，1200 默认值会把工具调用截断。
                maxTokens: 6_000,
              },
            )
          : await chat(config, messages, { maxTokens: 6_000 });
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

    let codeFile: AnswerResult["file"];
    let content = result.content;
    const codeBlocks =
      config.MEDIA_OUTBOUND_ENABLED && !fileSession.file ? extractCodeBlocks(content) : [];
    if (codeBlocks.length > 0) {
      try {
        codeFile = await writeCodeFile(
          codeBlocks,
          path.resolve(config.MEDIA_DIR, "outbound"),
          config.MEDIA_OUTBOUND_MAX_BYTES,
        );
        content = `${removeCodeBlocks(content)}\n\n代码已作为文件发送：${codeFile.filename}`;
      } catch (err) {
        logger.warn({ err, runId }, "code file creation failed");
      }
    }

    let text = sanitizeReply(content);
    if (searchSession.sources.length > 0 && !/https?:\/\//i.test(text)) {
      text += `\n\n来源：\n${formatSourceList(searchSession.sources)}`;
    }

    return {
      text,
      errorCode: null,
      promptTokens: result.promptTokens + attachmentPromptTokens,
      completionTokens: result.completionTokens + attachmentCompletionTokens,
      model: result.model,
      media: mediaSession.media,
      file: fileSession.file ?? codeFile,
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
