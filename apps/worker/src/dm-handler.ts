import crypto from "node:crypto";
import fsp from "node:fs/promises";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import type { AppConfig, Database, Logger, MessageRow } from "@xiaoqi/core";
import { agentDuration, budgetExceeded, llmTokens, messages, runs, runsTotal, users } from "@xiaoqi/core";
import { generateAnswer } from "./answer.js";
import {
  getSearchQuery,
  handleCommand,
  parseCommand,
  type CommandEffects,
} from "./commands.js";
import { welcomeText } from "./welcome.js";
import { sendFile, sendImage, sendTextChunks } from "./send.js";
import { dailyTokensUsed } from "./budget.js";
import { maybeAlertBudget } from "./alerts.js";

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
    const firstVisit = Boolean(user && !user.welcomedAt);
    const welcomePrefix = firstVisit ? `${welcomeText(config)}\n\n` : "";

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
          promptVersion: "dm@2026-11-08.2",
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
        promptVersion: "dm@2026-11-08.2",
        errorCode: null,
      })
      .where(eq(runs.id, run.id));

    const command = parseCommand(msg.text);
    const searchQuery = getSearchQuery(command);
    const forceSearch = searchQuery !== null;

    if (
      msg.userId &&
      !(
        command &&
        ["help", "whoami", "reset", "remind", "chart", "mermaid", "export"].includes(command.name)
      )
    ) {
      try {
        const used = await dailyTokensUsed(pool, msg.userId);
        await maybeAlertBudget(config, logger, {
          userId: msg.userId,
          used,
          limit: config.MAX_DAILY_TOKENS,
        });
        if (used >= config.MAX_DAILY_TOKENS) {
          const text = `今天的 AI 额度已用完（上限 ${config.MAX_DAILY_TOKENS.toLocaleString()} tokens），明天再试。`;
          await sendTextChunks(config, run.id, msg, text);
          await db
            .update(runs)
            .set({
              status: "failed",
              errorCode: "DAILY_BUDGET_EXCEEDED",
              model: "budget",
              latencyMs: Date.now() - startedAt,
              finishedAt: new Date(),
            })
            .where(eq(runs.id, run.id));
          budgetExceeded.inc();
          runsTotal.inc({ status: "budget_exceeded" });
          logger.warn({ runId: run.id, used }, "daily budget exceeded");
          return;
        }
      } catch (err) {
        logger.warn({ err, runId: run.id }, "budget check failed; continue");
      }
    }

    if (command && !forceSearch) {
      let reply: string;
      let commandError: string | null = null;
      const effects: CommandEffects = {};
      try {
        reply = welcomePrefix + (await handleCommand({ db, config, logger }, msg, user, command, effects));
      } catch (err) {
        commandError = "COMMAND_FAILED";
        reply = "这个命令没处理好，稍后再试。";
        logger.error({ err, runId: run.id, command: command.name }, "command failed");
      }
      try {
        if (effects.media) {
          const media = effects.media;
          try {
            await sendImage(config, run.id, msg, media);
            await fsp.unlink(media.path).catch(() => undefined);
          } catch (err) {
            commandError = "IMAGE_SEND_FAILED";
            reply += "\n\n（图片发送失败，稍后再试）";
            logger.warn({ err, runId: run.id }, "image send failed");
          }
        }
        if (effects.file) {
          const file = effects.file;
          try {
            await sendFile(config, run.id, msg, file);
            await fsp.unlink(file.path).catch(() => undefined);
          } catch (err) {
            commandError = "FILE_SEND_FAILED";
            reply += "\n\n（文件发送失败，稍后再试）";
            logger.warn({ err, runId: run.id }, "file send failed");
          }
        }
        const chunks = await sendTextChunks(config, run.id, msg, reply);
        await db
          .update(runs)
          .set({
            status: commandError ? "failed" : "sent",
            errorCode: commandError,
            model: "command",
            promptVersion: "commands@2026-11-08.2",
            latencyMs: Date.now() - startedAt,
            finishedAt: new Date(),
          })
          .where(eq(runs.id, run.id));
        runsTotal.inc({ status: commandError ? "failed" : "sent" });
        if (firstVisit && user) {
          await db.update(users).set({ welcomedAt: new Date() }).where(eq(users.id, user.id));
        }
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
    let answerMedia: { path: string; mime: string; filename: string } | undefined;

    {
      const answer = await generateAnswer({ config, db, pool, logger }, msg, run.id, run.traceId, user, {
        query: searchQuery ?? undefined,
        forceSearch,
      });
      replyText = welcomePrefix + answer.text;
      errorCode = answer.errorCode;
      promptTokens = answer.promptTokens;
      completionTokens = answer.completionTokens;
      model = answer.model;
      answerMedia = answer.media;
    }

    if (answerMedia) {
      try {
        await sendImage(config, run.id, msg, answerMedia);
        await fsp.unlink(answerMedia.path).catch(() => undefined);
      } catch (err) {
        logger.warn({ err, runId: run.id }, "answer image send failed");
        replyText += "\n\n（图片发送失败，稍后再试）";
        errorCode = errorCode ?? "IMAGE_SEND_FAILED";
      }
    }

    try {
      const chunks = await sendTextChunks(config, run.id, msg, replyText);
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
      runsTotal.inc({ status: errorCode ? "failed" : "sent" });
      agentDuration.observe({ model }, (Date.now() - startedAt) / 1000);
      llmTokens.inc({ type: "prompt" }, promptTokens);
      llmTokens.inc({ type: "completion" }, completionTokens);
      if (firstVisit && user) {
        await db.update(users).set({ welcomedAt: new Date() }).where(eq(users.id, user.id));
      }
      logger.info({ runId: run.id, chunks, errorCode, model }, "dm answer sent");
    } catch (err) {
      runsTotal.inc({ status: "failed" });
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
