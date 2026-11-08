import { and, eq } from "drizzle-orm";
import type { AppConfig, Database } from "@xiaoqi/core";
import {
  AppError,
  accounts,
  contextTokens,
  decryptSecret,
  messages,
  type AccountRow,
} from "@xiaoqi/core";
import { ILinkClient } from "@xiaoqi/ilink";

export interface SendContext {
  account: AccountRow;
  target: string;
  botToken: string;
  contextToken: string;
}

export async function loadSendContext(
  db: Database,
  config: AppConfig,
  accountId: string,
  conversationKey: string,
  target?: string,
): Promise<SendContext> {
  const accountRows = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const account = accountRows[0];
  if (!account?.tokenEnc) {
    throw new AppError({ code: "ACCOUNT_NOT_READY", message: "account has no token", httpStatus: 409 });
  }

  const tokenRows = await db
    .select()
    .from(contextTokens)
    .where(
      and(eq(contextTokens.accountId, accountId), eq(contextTokens.conversationKey, conversationKey)),
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

  return {
    account,
    target: target ?? conversationKey.replace(/^dm:/, ""),
    botToken: decryptSecret(account.tokenEnc, config.masterKey),
    contextToken: decryptSecret(tokenRow.tokenEnc, config.masterKey),
  };
}

export async function sendText(
  config: AppConfig,
  ctx: SendContext,
  text: string,
  clientId: string,
): Promise<{ wxMessageId: string }> {
  const client = createClient(config, ctx);
  const resp = await client.sendText({
    toUserId: ctx.target,
    contextToken: ctx.contextToken,
    text,
    clientId,
  });
  return { wxMessageId: wxMessageIdOf(resp) };
}

export async function sendImage(
  config: AppConfig,
  ctx: SendContext,
  data: Buffer,
  mime: string,
  clientId: string,
): Promise<{ wxMessageId: string }> {
  const client = createClient(config, ctx);
  const resp = await client.sendImage({
    toUserId: ctx.target,
    contextToken: ctx.contextToken,
    data,
    mime,
    clientId,
  });
  return { wxMessageId: wxMessageIdOf(resp) };
}

export async function sendFile(
  config: AppConfig,
  ctx: SendContext,
  data: Buffer,
  fileName: string,
  clientId: string,
): Promise<{ wxMessageId: string }> {
  const client = createClient(config, ctx);
  const resp = await client.sendFile({
    toUserId: ctx.target,
    contextToken: ctx.contextToken,
    data,
    fileName,
    clientId,
  });
  return { wxMessageId: wxMessageIdOf(resp) };
}

export async function recordOutbound(
  db: Database,
  input: {
    accountId: string;
    userId: string | null;
    conversationKey: string;
    senderId: string;
    wxMessageId: string;
    text: string;
    itemType?: string;
  },
): Promise<void> {
  if (!input.wxMessageId) return;
  await db
    .insert(messages)
    .values({
      accountId: input.accountId,
      userId: input.userId,
      conversationKey: input.conversationKey,
      wxMessageId: input.wxMessageId,
      senderId: input.senderId,
      direction: "out",
      messageType: 2,
      itemType: input.itemType ?? "text",
      text: input.text,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
}

function createClient(config: AppConfig, ctx: SendContext): ILinkClient {
  return new ILinkClient({
    baseUrl: ctx.account.baseUrl,
    token: ctx.botToken,
    appId: config.ILINK_APP_ID,
    clientVersion: config.ILINK_APP_VERSION,
    cdnBaseUrl: config.ILINK_CDN_BASE,
  });
}

function wxMessageIdOf(resp: Record<string, unknown>): string {
  return String(
    (resp as { message_id?: unknown }).message_id ??
      (resp as { msg?: { message_id?: unknown } }).msg?.message_id ??
      "",
  );
}
