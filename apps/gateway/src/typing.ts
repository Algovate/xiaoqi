import { and, eq } from "drizzle-orm";
import type { AppConfig, Database, Logger } from "@xiaoqi/core";
import { accounts, contextTokens, decryptSecret, messages } from "@xiaoqi/core";
import { ILinkClient } from "@xiaoqi/ilink";

export interface TypingService {
  setTyping(replyToMessageId: number, on: boolean): Promise<{ ok: boolean; reason?: string }>;
}

export function createTypingService(deps: {
  config: AppConfig;
  db: Database;
  logger: Logger;
}): TypingService {
  const { config, db, logger } = deps;
  const tickets = new Map<string, string>();

  return {
    async setTyping(replyToMessageId, on) {
      const sourceRows = await db
        .select()
        .from(messages)
        .where(eq(messages.id, replyToMessageId))
        .limit(1);
      const source = sourceRows[0];
      if (!source) return { ok: false, reason: "MESSAGE_NOT_FOUND" };

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
        let ticket = tickets.get(cacheKey);
        if (!ticket) {
          const cfg = await client.getConfig(source.senderId, contextToken);
          ticket = cfg.typing_ticket;
          if (ticket) tickets.set(cacheKey, ticket);
        }
        if (!ticket) return { ok: false, reason: "NO_TYPING_TICKET" };
        await client.sendTyping(source.senderId, ticket, on);
        return { ok: true };
      } catch (err) {
        logger.debug({ err }, "typing failed");
        return { ok: false, reason: "TYPING_FAILED" };
      }
    },
  };
}
