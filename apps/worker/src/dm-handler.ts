import crypto from "node:crypto";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import type { AppConfig, Database, Logger, MessageRow } from "@xiaoqi/core";
import { messages, runs, users } from "@xiaoqi/core";
import { buildContext } from "./context.js";
import { handleCommand, parseCommand } from "./commands.js";
import { chunkReply, sanitizeReply } from "./format.js";
import { chat } from "./llm.js";
import { extractAttachments } from "./media.js";
import { searchKnowledge } from "./kb.js";

interface DmJob {
  accountId: string;
  messageId: string;
}

export interface DmHandlerDeps {
  config: AppConfig;
  db: Database;
  pool: Pool;
  logger: Logger;
}

export function createDmHandler(deps: DmHandlerDeps) {
  const { config, db, pool, logger } = deps;

  async function typing(replyToMessageId: number, on: boolean): Promise<void> {
    try {
      const resp = await fetch(`${config.GATEWAY_INTERNAL_URL}/internal/v1/typing`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-xiaoqi-internal": config.internalToken,
        },
        body: JSON.stringify({ replyToMessageId: String(replyToMessageId), on }),
      });
      if (!resp.ok) logger.debug({ status: resp.status }, "typing request failed");
    } catch (err) {
      logger.debug({ err }, "typing request error");
    }
  }

  async function sendChunks(runId: string, msg: MessageRow, text: string): Promise<number> {
    const chunks = chunkReply(text);
    for (let i = 0; i < chunks.length; i += 1) {
      const resp = await fetch(`${config.GATEWAY_INTERNAL_URL}/internal/v1/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-xiaoqi-internal": config.internalToken,
        },
        body: JSON.stringify({
          runId,
          chunkIndex: i,
          replyToMessageId: String(msg.id),
          text: chunks[i],
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`gateway send failed http=${resp.status} ${body.slice(0, 300)}`);
      }
    }
    return chunks.length;
  }

  return async function handle(job: Job<DmJob>): Promise<void> {
    const { accountId, messageId } = job.data;
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.id, Number(messageId)))
      .limit(1);
    const msg = rows[0];
    if (!msg || msg.direction !== "in" || msg.accountId !== accountId) {
      logger.warn({ accountId, messageId }, "dm job skipped: message not found/not inbound");
      return;
    }

    const userRows = msg.userId
      ? await db.select().from(users).where(eq(users.id, msg.userId)).limit(1)
      : [];
    const user = userRows[0] ?? null;

    const existing = await db
      .select()
      .from(runs)
      .where(eq(runs.triggerMessageId, msg.id))
      .limit(1);
    let run = existing[0];

    if (!run) {
      const inserted = await db
        .insert(runs)
        .values({
          accountId,
          userId: msg.userId,
          triggerMessageId: msg.id,
          status: "running",
          model: config.LLM_MODEL,
          promptVersion: "dm@2026-11-06.2",
          traceId: crypto.randomUUID(),
        })
        .onConflictDoNothing()
        .returning();
      run = inserted[0];
    }

    if (!run) {
      logger.warn({ accountId, messageId }, "run conflict but not found");
      return;
    }
    if (run.status === "sent") {
      logger.debug({ runId: run.id }, "run already sent; skip");
      return;
    }

    const startedAt = Date.now();
    await db
      .update(runs)
      .set({
        status: "running",
        model: config.LLM_MODEL,
        promptVersion: "dm@2026-11-06.2",
        errorCode: null,
      })
      .where(eq(runs.id, run.id));

    const command = parseCommand(msg.text);

    if (command) {
      let reply: string;
      let commandError: string | null = null;
      try {
        reply = await handleCommand({ db, config }, msg, user, command);
      } catch (err) {
        commandError = "COMMAND_FAILED";
        reply = "这个命令没处理好，稍后再试。";
        logger.error({ err, runId: run.id, command: command.name }, "command failed");
      }
      try {
        const chunks = await sendChunks(run.id, msg, reply);
        await db
          .update(runs)
          .set({
            status: commandError ? "failed" : "sent",
            errorCode: commandError,
            model: "command",
            promptVersion: "commands@2026-11-06.1",
            latencyMs: Date.now() - startedAt,
            finishedAt: new Date(),
          })
          .where(eq(runs.id, run.id));
        logger.info({ runId: run.id, command: command.name, chunks }, "command handled");
        return;
      } catch (err) {
        await db
          .update(runs)
          .set({
            status: "failed",
            errorCode: "SEND_FAILED",
            latencyMs: Date.now() - startedAt,
            finishedAt: new Date(),
          })
          .where(eq(runs.id, run.id));
        throw err;
      }
    }

    await typing(msg.id, true);

    let replyText: string;
    let errorCode: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let model = config.LLM_MODEL;

    try {
      const attachmentText = await extractAttachments(db, config, msg);
      const currentQuestion = msg.text?.trim() || (attachmentText ? "请分析我发的附件" : "（非文本消息）");
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
          runId: run.id,
          contextMessages: context.messageCount,
          attachmentChars: attachmentText.length,
        },
        "calling llm",
      );
      const result = await chat(config, [
        { role: "system", content: context.system },
        { role: "user", content: context.user },
      ]);
      replyText = sanitizeReply(result.content);
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
      model = result.model;
    } catch (err) {
      errorCode = "LLM_FAILED";
      replyText = `这次没答上来，稍后再试。（trace: ${(run.traceId ?? "").slice(0, 8)}）`;
      logger.error({ err, runId: run.id }, "llm failed; sending fallback");
    }

    try {
      const chunks = await sendChunks(run.id, msg, replyText);
      await db
        .update(runs)
        .set({
          status: errorCode ? "failed" : "sent",
          errorCode,
          model,
          promptTokens,
          completionTokens,
          latencyMs: Date.now() - startedAt,
          finishedAt: new Date(),
        })
        .where(eq(runs.id, run.id));
      logger.info({ runId: run.id, chunks, errorCode, model }, "dm answer sent");
    } catch (err) {
      await db
        .update(runs)
        .set({
          status: "failed",
          errorCode: errorCode ?? "SEND_FAILED",
          latencyMs: Date.now() - startedAt,
          finishedAt: new Date(),
        })
        .where(eq(runs.id, run.id));
      throw err;
    } finally {
      await typing(msg.id, false);
    }
  };
}
