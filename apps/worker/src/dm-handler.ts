import crypto from "node:crypto";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import type { AppConfig, Database, Logger } from "@xiaoqi/core";
import { messages, outboundMessages, runs } from "@xiaoqi/core";

interface DmJob {
  accountId: string;
  messageId: string;
}

export interface DmHandlerDeps {
  config: AppConfig;
  db: Database;
  logger: Logger;
}

export function createDmHandler(deps: DmHandlerDeps) {
  const { config, db, logger } = deps;

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
          model: "echo-m1",
          promptVersion: "m1",
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

    const replyText = `收到：${msg.text?.trim() || "（非文本消息，M1 先做文本 echo）"}`;
    logger.info({ runId: run.id, accountId, messageId }, "echoing DM");

    const resp = await fetch(`${config.GATEWAY_INTERNAL_URL}/internal/v1/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xiaoqi-internal": config.internalToken,
      },
      body: JSON.stringify({
        runId: run.id,
        chunkIndex: 0,
        replyToMessageId: String(msg.id),
        text: replyText,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      await db
        .update(runs)
        .set({ status: "failed", errorCode: `GATEWAY_${resp.status}`, finishedAt: new Date() })
        .where(eq(runs.id, run.id));
      throw new Error(`gateway send failed http=${resp.status} ${body.slice(0, 300)}`);
    }

    const body = (await resp.json()) as { wxMessageId?: string; deduplicated?: boolean };
    await db
      .update(outboundMessages)
      .set({ status: "sent", wxMessageId: body.wxMessageId ?? null, sentAt: new Date() })
      .where(eq(outboundMessages.runId, run.id));
    await db
      .update(runs)
      .set({ status: "sent", finishedAt: new Date() })
      .where(eq(runs.id, run.id));
    logger.info({ runId: run.id, wxMessageId: body.wxMessageId }, "echo sent");
  };
}
