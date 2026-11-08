import crypto from "node:crypto";
import path from "node:path";
import Fastify, { type FastifyBaseLogger } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppConfig, DbHandle, Logger } from "@xiaoqi/core";
import {
  AppError,
  imageMimeOf,
  messages,
  outboundMessages,
  runs,
  sendDuration,
  sendTotal,
  metricsContentType,
  metricsText,
} from "@xiaoqi/core";
import {
  loadSendContext,
  recordOutbound,
  sendFile,
  sendImage,
  sendText,
  type SendContext,
} from "./outbound.js";
import { createTypingService } from "./typing.js";

const SendSchema = z.object({
  runId: z.string().uuid(),
  chunkIndex: z.number().int().min(0).max(2),
  replyToMessageId: z.string().regex(/^\d+$/),
  text: z.string().min(1).max(4000),
});

const SendImageSchema = z.object({
  runId: z.string().uuid(),
  replyToMessageId: z.string().regex(/^\d+$/),
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  filename: z.string().min(1).max(120),
  dataBase64: z.string().min(1).max(7_000_000),
});

const SendFileSchema = z.object({
  runId: z.string().uuid(),
  replyToMessageId: z.string().regex(/^\d+$/),
  fileName: z.string().min(1).max(120),
  mime: z.string().min(1).max(120),
  dataBase64: z.string().min(1).max(7_000_000),
});

const IMAGE_CHUNK_INDEX = 100;
const FILE_CHUNK_INDEX = 101;

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
  const typingService = createTypingService({ config, db, logger });
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    bodyLimit: 8 * 1024 * 1024,
  });

  async function loadRunAndSource(runId: string, replyToMessageId: string) {
    const runRows = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    const run = runRows[0];
    if (!run) throw new AppError({ code: "RUN_NOT_FOUND", message: "run not found", httpStatus: 404 });

    const messageRows = await db
      .select()
      .from(messages)
      .where(eq(messages.id, Number(replyToMessageId)))
      .limit(1);
    const source = messageRows[0];
    if (!source) {
      throw new AppError({ code: "MESSAGE_NOT_FOUND", message: "source message not found", httpStatus: 404 });
    }
    return { run, source };
  }

  async function sendMedia(
    input: {
      runId: string;
      replyToMessageId: string;
      chunkIndex: number;
      kind: "image" | "file";
      mime: string;
      filename: string;
      data: Buffer;
      recordText: string;
      itemType: "image" | "file";
      label: string;
      send: (
        ctx: SendContext,
        data: Buffer,
        filename: string,
        mime: string,
        clientId: string,
      ) => Promise<{ wxMessageId: string }>;
    },
    log: FastifyBaseLogger,
  ) {
    const { run, source } = await loadRunAndSource(input.runId, input.replyToMessageId);

    await db
      .insert(outboundMessages)
      .values({
        runId: input.runId,
        chunkIndex: input.chunkIndex,
        kind: input.kind,
        storageKey: input.filename,
        mime: input.mime,
        sizeBytes: input.data.length,
        status: "pending",
      })
      .onConflictDoNothing();

    const outRows = await db
      .select()
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.runId, input.runId),
          eq(outboundMessages.chunkIndex, input.chunkIndex),
        ),
      )
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
      const { wxMessageId } = await input.send(
        sendContext,
        input.data,
        input.filename,
        input.mime,
        `xiaoqi-${input.runId}-${input.kind}`,
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
        text: input.recordText,
        itemType: input.itemType,
      });
      return { ok: true, wxMessageId, sentAt: new Date().toISOString(), deduplicated: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendTotal.inc({ result: "failed" });
      await db
        .update(outboundMessages)
        .set({ status: "failed", errorCode: "SEND_FAILED" })
        .where(eq(outboundMessages.id, outbound.id));
      log.error({ err, runId: input.runId }, `${input.label} send failed`);
      throw new AppError({ code: "SEND_FAILED", message, httpStatus: 502, retryable: true });
    }
  }

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

    const { run, source } = await loadRunAndSource(input.runId, input.replyToMessageId);

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

  app.post("/internal/v1/send-image", async (req, reply) => {
    const parsed = SendImageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "VALIDATION_ERROR", message: parsed.error.issues.map((i) => i.message).join("; ") },
      });
    }
    const input = parsed.data;
    if (!config.MEDIA_OUTBOUND_ENABLED) {
      throw new AppError({
        code: "MEDIA_OUTBOUND_DISABLED",
        message: "media outbound disabled",
        httpStatus: 403,
      });
    }

    const image = Buffer.from(input.dataBase64, "base64");
    if (image.length === 0) {
      throw new AppError({ code: "INVALID_IMAGE", message: "empty image", httpStatus: 400 });
    }
    if (image.length > config.MEDIA_OUTBOUND_MAX_BYTES) {
      throw new AppError({ code: "IMAGE_TOO_LARGE", message: "image too large", httpStatus: 413 });
    }
    const detectedMime = imageMimeOf(image);
    if (!detectedMime || detectedMime !== input.mime) {
      throw new AppError({ code: "INVALID_IMAGE", message: "image bytes do not match mime", httpStatus: 400 });
    }

    return sendMedia(
      {
        runId: input.runId,
        replyToMessageId: input.replyToMessageId,
        chunkIndex: IMAGE_CHUNK_INDEX,
        kind: "image",
        mime: detectedMime,
        filename: path.basename(input.filename),
        data: image,
        recordText: "[图片]",
        itemType: "image",
        label: "image",
        send: (ctx, data, _filename, mime, clientId) => sendImage(config, ctx, data, mime, clientId),
      },
      req.log,
    );
  });

  app.post("/internal/v1/send-file", async (req, reply) => {
    const parsed = SendFileSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "VALIDATION_ERROR", message: parsed.error.issues.map((i) => i.message).join("; ") },
      });
    }
    const input = parsed.data;
    if (!config.MEDIA_OUTBOUND_ENABLED) {
      throw new AppError({
        code: "MEDIA_OUTBOUND_DISABLED",
        message: "media outbound disabled",
        httpStatus: 403,
      });
    }

    const data = Buffer.from(input.dataBase64, "base64");
    if (data.length === 0) {
      throw new AppError({ code: "INVALID_FILE", message: "empty file", httpStatus: 400 });
    }
    if (data.length > config.MEDIA_OUTBOUND_MAX_BYTES) {
      throw new AppError({ code: "FILE_TOO_LARGE", message: "file too large", httpStatus: 413 });
    }
    const fileName = path.basename(input.fileName);
    if (!fileName || fileName === "." || fileName === "..") {
      throw new AppError({ code: "INVALID_FILE", message: "invalid file name", httpStatus: 400 });
    }

    return sendMedia(
      {
        runId: input.runId,
        replyToMessageId: input.replyToMessageId,
        chunkIndex: FILE_CHUNK_INDEX,
        kind: "file",
        mime: input.mime,
        filename: fileName,
        data,
        recordText: `[文件] ${fileName}`,
        itemType: "file",
        label: "file",
        send: (ctx, data, filename, _mime, clientId) => sendFile(config, ctx, data, filename, clientId),
      },
      req.log,
    );
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
    return typingService.setTyping(Number(parsed.data.replyToMessageId), parsed.data.on);
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
