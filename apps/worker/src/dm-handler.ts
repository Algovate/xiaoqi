import crypto from "node:crypto";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import type { AppConfig, Database, Logger, MessageRow } from "@xiaoqi/core";
import { agentDuration, budgetExceeded, llmTokens, messages, runs, runsTotal, users } from "@xiaoqi/core";
import { generateAnswer } from "./answer.js";
import { handleCommand, parseCommand } from "./commands.js";
import { chunkReply } from "./format.js";
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

    if (msg.userId && !(command && ["help", "whoami", "reset", "remind"].includes(command.name))) {
      try {
        const used = await dailyTokensUsed(pool, msg.userId);
        await maybeAlertBudget(config, logger, {
          userId: msg.userId,
          used,
          limit: config.MAX_DAILY_TOKENS,
        });
        if (used >= config.MAX_DAILY_TOKENS) {
          const text = `今天的 AI 额度已用完（上限 ${config.MAX_DAILY_TOKENS.toLocaleString()} tokens），明天再试。`;
          await sendChunks(run.id, msg, text);
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
        runsTotal.inc({ status: commandError ? "failed" : "sent" });
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

    {
      const answer = await generateAnswer({ config, db, pool, logger }, msg, run.id, run.traceId, user);
      replyText = answer.text;
      errorCode = answer.errorCode;
      promptTokens = answer.promptTokens;
      completionTokens = answer.completionTokens;
      model = answer.model;
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
      runsTotal.inc({ status: errorCode ? "failed" : "sent" });
      agentDuration.observe({ model }, (Date.now() - startedAt) / 1000);
      llmTokens.inc({ type: "prompt" }, promptTokens);
      llmTokens.inc({ type: "completion" }, completionTokens);
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
