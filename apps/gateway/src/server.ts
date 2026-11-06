import Fastify, { type FastifyBaseLogger } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppConfig, DbHandle, Logger } from "@xiaoqi/core";
import {
  AppError,
  accounts,
  contextTokens,
  decryptSecret,
  messages,
  outboundMessages,
  runs,
} from "@xiaoqi/core";
import { ILinkClient } from "@xiaoqi/ilink";

const SendSchema = z.object({
  runId: z.string().uuid(),
  chunkIndex: z.number().int().min(0).max(2),
  replyToMessageId: z.string().regex(/^\d+$/),
  text: z.string().min(1).max(4000),
});

export interface ServerDeps {
  config: AppConfig;
  dbHandle: DbHandle;
  logger: Logger;
}

export async function buildServer(deps: ServerDeps) {
  const { config, dbHandle, logger } = deps;
  const { db } = dbHandle;
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/internal/")) return;
    if (req.headers["x-xiaoqi-internal"] !== config.internalToken) {
      await reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "invalid internal token" } });
    }
  });

  app.get("/healthz", async () => ({ ok: true, service: "gateway" }));

  app.get("/internal/v1/health", async () => ({
    ok: true,
    service: "gateway",
    uptime: process.uptime(),
  }));

  app.post("/internal/v1/send", async (req, reply) => {
    const parsed = SendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "VALIDATION_ERROR", message: parsed.error.issues.map((i) => i.message).join("; ") },
      });
    }
    const input = parsed.data;

    const runRows = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
    const run = runRows[0];
    if (!run) throw new AppError({ code: "RUN_NOT_FOUND", message: "run not found", httpStatus: 404 });

    const messageRows = await db
      .select()
      .from(messages)
      .where(eq(messages.id, Number(input.replyToMessageId)))
      .limit(1);
    const source = messageRows[0];
    if (!source) {
      throw new AppError({ code: "MESSAGE_NOT_FOUND", message: "source message not found", httpStatus: 404 });
    }

    await db
      .insert(outboundMessages)
      .values({ runId: input.runId, chunkIndex: input.chunkIndex, status: "pending" })
      .onConflictDoNothing();

    const outRows = await db
      .select()
      .from(outboundMessages)
      .where(and(eq(outboundMessages.runId, input.runId), eq(outboundMessages.chunkIndex, input.chunkIndex)))
      .limit(1);
    const outbound = outRows[0];
    if (!outbound) throw new AppError({ code: "OUTBOUND_NOT_FOUND", message: "outbound row missing" });
    if (outbound.status === "sent") {
      return { ok: true, wxMessageId: outbound.wxMessageId, sentAt: outbound.sentAt, deduplicated: true };
    }

    const accountRows = await db.select().from(accounts).where(eq(accounts.id, run.accountId)).limit(1);
    const account = accountRows[0];
    if (!account?.tokenEnc) {
      throw new AppError({ code: "ACCOUNT_NOT_READY", message: "account has no token", httpStatus: 409 });
    }

    const tokenRows = await db
      .select()
      .from(contextTokens)
      .where(
        and(
          eq(contextTokens.accountId, run.accountId),
          eq(contextTokens.conversationKey, source.conversationKey),
        ),
      )
      .limit(1);
    const tokenRow = tokenRows[0];
    if (!tokenRow) {
      throw new AppError({
        code: "CONTEXT_TOKEN_MISSING",
        message: "no context token for conversation",
        httpStatus: 409,
      });
    }

    const botToken = decryptSecret(account.tokenEnc, config.masterKey);
    const contextToken = decryptSecret(tokenRow.tokenEnc, config.masterKey);
    const client = new ILinkClient({
      baseUrl: account.baseUrl,
      token: botToken,
      appId: config.ILINK_APP_ID,
      clientVersion: config.ILINK_APP_VERSION,
    });

    try {
      const resp = await client.sendText({
        toUserId: source.senderId,
        contextToken,
        text: input.text,
        clientId: `xiaoqi-${input.runId}-${input.chunkIndex}`,
      });
      const wxMessageId = String(
        (resp as { message_id?: unknown }).message_id ??
          (resp as { msg?: { message_id?: unknown } }).msg?.message_id ??
          "",
      );
      await db
        .update(outboundMessages)
        .set({ status: "sent", wxMessageId, sentAt: new Date() })
        .where(eq(outboundMessages.id, outbound.id));
      await db
        .update(runs)
        .set({ status: "sent", finishedAt: new Date() })
        .where(eq(runs.id, input.runId));
      return { ok: true, wxMessageId, sentAt: new Date().toISOString(), deduplicated: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(outboundMessages)
        .set({ status: "failed", errorCode: "SEND_FAILED" })
        .where(eq(outboundMessages.id, outbound.id));
      await db
        .update(runs)
        .set({ status: "failed", errorCode: "SEND_FAILED", finishedAt: new Date() })
        .where(eq(runs.id, input.runId));
      req.log.error({ err, runId: input.runId }, "send failed");
      throw new AppError({ code: "SEND_FAILED", message, httpStatus: 502, retryable: true });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.httpStatus).send({
        error: { code: err.code, message: err.message, retryable: err.retryable },
      });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
  });

  return app;
}
