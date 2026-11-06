import type { Pool } from "pg";
import type { AppConfig, Database, Logger, MessageRow, UserRow } from "@xiaoqi/core";
import { buildContext } from "./context.js";
import { searchKnowledge } from "./kb.js";
import { chat } from "./llm.js";
import { extractAttachments } from "./media.js";
import { sanitizeReply } from "./format.js";

export interface AnswerResult {
  text: string;
  errorCode: string | null;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export async function generateAnswer(
  deps: { config: AppConfig; db: Database; pool: Pool; logger: Logger },
  msg: MessageRow,
  runId: string,
  traceId: string | null,
  _user: UserRow | null,
): Promise<AnswerResult> {
  const { config, db, pool, logger } = deps;

  try {
    const attachmentText = await extractAttachments(db, config, msg);
    const currentQuestion =
      msg.text?.trim() || (attachmentText ? "请分析我发的附件" : "（非文本消息）");

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
      },
      "calling llm",
    );

    const result = await chat(config, [
      { role: "system", content: context.system },
      { role: "user", content: context.user },
    ]);

    return {
      text: sanitizeReply(result.content),
      errorCode: null,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      model: result.model,
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
