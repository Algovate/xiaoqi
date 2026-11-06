import crypto from "node:crypto";
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
  sendDuration,
  sendTotal,
  metricsContentType,
  metricsText,
} from "@xiaoqi/core";
import { ILinkClient } from "@xiaoqi/ilink";
import { loadSendContext, recordOutbound, sendText } from "./outbound.js";

const SendSchema = z.object({
  runId: z.string().uuid(),
  chunkIndex: z.number().int().min(0).max(2),
  replyToMessageId: z.string().regex(/^\d+$/),
  text: z.string().min(1).max(4000),
});

const TypingSchema = z.object({
  replyToMessageId: z.string().regex(/^\d+$/),
  on: z.boolean(),
});

const ProactiveSchema = z.object({
  accountId: z.string().uuid(),
  conversationKey: z.string().startsWith("dm:"),
  text: z.string().min(1).max(4000),
  reminderId: z.string().uuid().optional(),
});

export interface ServerDeps {
  config: AppConfig;
  dbHandle: DbHandle;
  logger: Logger;
}

export async function buildServer(deps: ServerDeps) {
  const { config, dbHandle, logger } = deps;
  const { db } = dbHandle;
  const typingTickets = new Map<string, string>();
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/internal/")) return;
    if (req.headers["x-xiaoqi-internal"] !== config.internalToken) {
      await reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "invalid internal token" } });
    }
  });

  app.get("/healthz", async () => ({ ok: true, service: "gateway" }));

  app.get("/metrics", async (_req, reply) => {
    return reply.type(metricsContentType).send(await metricsText());
  });

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
      sendTotal.inc({ result: "deduplicated" });
      return { ok: true, wxMessageId: outbound.wxMessageId, sentAt: outbound.sentAt, deduplicated: true };
    }

    const sendContext = await loadSendContext(
      db,
      config,
      run.accountId,
      source.conversationKey,
      source.senderId,
    );

    const sendStarted = process.hrtime.bigint();
    try {
      const { wxMessageId } = await sendText(
        config,
        sendContext,
        input.text,
        `xiaoqi-${input.runId}-${input.chunkIndex}`,
      );
      sendDuration.observe(Number(process.hrtime.bigint() - sendStarted) / 1e9);
      sendTotal.inc({ result: "sent" });
      await db
        .update(outboundMessages)
        .set({ status: "sent", wxMessageId, sentAt: new Date() })
        .where(eq(outboundMessages.id, outbound.id));
      await recordOutbound(db, {
        accountId: run.accountId,
        userId: source.userId,
        conversationKey: source.conversationKey,
        senderId: sendContext.account.ilinkBotId,
        wxMessageId,
        text: input.text,
      });
      return { ok: true, wxMessageId, sentAt: new Date().toISOString(), deduplicated: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendTotal.inc({ result: "failed" });
      await db
        .update(outboundMessages)
        .set({ status: "failed", errorCode: "SEND_FAILED" })
        .where(eq(outboundMessages.id, outbound.id));
      req.log.error({ err, runId: input.runId }, "send failed");
      throw new AppError({ code: "SEND_FAILED", message, httpStatus: 502, retryable: true });
    }
  });

  app.post("/internal/v1/send-proactive", async (req, reply) => {
    const parsed = ProactiveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "bad proactive payload" } });
    }
    const { accountId, conversationKey, text } = parsed.data;

    const sendContext = await loadSendContext(db, config, accountId, conversationKey);

    const runRows = await db
      .insert(runs)
      .values({
        accountId,
        status: "running",
        model: "reminder",
        promptVersion: "reminder@2026-11-06.1",
        traceId: crypto.randomUUID(),
      })
      .returning();
    const run = runRows[0]!;

    await db
      .insert(outboundMessages)
      .values({ runId: run.id, chunkIndex: 0, status: "pending" })
      .onConflictDoNothing();

    const sendStarted = process.hrtime.bigint();
    try {
      const { wxMessageId } = await sendText(config, sendContext, text, `xiaoqi-reminder-${run.id}`);
      sendDuration.observe(Number(process.hrtime.bigint() - sendStarted) / 1e9);
      sendTotal.inc({ result: "sent" });
      await db
        .update(outboundMessages)
        .set({ status: "sent", wxMessageId, sentAt: new Date() })
        .where(eq(outboundMessages.runId, run.id));
      await db
        .update(runs)
        .set({ status: "sent", finishedAt: new Date() })
        .where(eq(runs.id, run.id));
      await recordOutbound(db, {
        accountId,
        userId: null,
        conversationKey,
        senderId: sendContext.account.ilinkBotId,
        wxMessageId,
        text,
      });
      return { ok: true, wxMessageId, runId: run.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendTotal.inc({ result: "failed" });
      await db
        .update(outboundMessages)
        .set({ status: "failed", errorCode: "SEND_FAILED" })
        .where(eq(outboundMessages.runId, run.id));
      await db
        .update(runs)
        .set({ status: "failed", errorCode: "SEND_FAILED", finishedAt: new Date() })
        .where(eq(runs.id, run.id));
      req.log.error({ err, accountId, conversationKey }, "proactive send failed");
      throw new AppError({ code: "SEND_FAILED", message, httpStatus: 502, retryable: true });
    }
  });

  app.post("/internal/v1/typing", async (req, reply) => {
    const parsed = TypingSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "bad typing payload" } });
    }
    const sourceRows = await db
      .select()
      .from(messages)
      .where(eq(messages.id, Number(parsed.data.replyToMessageId)))
      .limit(1);
    const source = sourceRows[0];
    if (!source) return reply.code(404).send({ error: { code: "MESSAGE_NOT_FOUND", message: "not found" } });

    const accountRows = await db.select().from(accounts).where(eq(accounts.id, source.accountId)).limit(1);
    const account = accountRows[0];
    if (!account?.tokenEnc) return { ok: false, reason: "ACCOUNT_NOT_READY" };

    const tokenRows = await db
      .select()
      .from(contextTokens)
      .where(
        and(
          eq(contextTokens.accountId, source.accountId),
          eq(contextTokens.conversationKey, source.conversationKey),
        ),
      )
      .limit(1);
    if (!tokenRows[0]) return { ok: false, reason: "CONTEXT_TOKEN_MISSING" };

    try {
      const botToken = decryptSecret(account.tokenEnc, config.masterKey);
      const contextToken = decryptSecret(tokenRows[0].tokenEnc, config.masterKey);
      const client = new ILinkClient({
        baseUrl: account.baseUrl,
        token: botToken,
        appId: config.ILINK_APP_ID,
        clientVersion: config.ILINK_APP_VERSION,
      });
      const cacheKey = `${source.accountId}:${source.senderId}`;
      let ticket = typingTickets.get(cacheKey);
      if (!ticket) {
        const cfg = await client.getConfig(source.senderId, contextToken);
        ticket = cfg.typing_ticket;
        if (ticket) typingTickets.set(cacheKey, ticket);
      }
      if (!ticket) return { ok: false, reason: "NO_TYPING_TICKET" };
      await client.sendTyping(source.senderId, ticket, parsed.data.on);
      return { ok: true };
    } catch (err) {
      req.log.debug({ err }, "typing failed");
      return { ok: false, reason: "TYPING_FAILED" };
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
