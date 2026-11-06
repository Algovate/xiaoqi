import type { AppConfig, Database } from "@xiaoqi/core";
import {
  accountCursors,
  contextTokens,
  encryptSecret,
  messages,
  outbox,
  users,
} from "@xiaoqi/core";
import { extractText, itemTypeOf, wxId, type WeixinMessage } from "@xiaoqi/ilink";
import { eq } from "drizzle-orm";

export interface PersistResult {
  inserted: number;
  skipped: number;
}

export async function persistInboundBatch(
  db: Database,
  config: AppConfig,
  accountId: string,
  msgs: WeixinMessage[],
  nextBuf: string,
): Promise<PersistResult> {
  let inserted = 0;
  let skipped = 0;

  await db.transaction(async (tx) => {
    for (const msg of msgs) {
      if (msg.message_type !== 1) {
        skipped += 1;
        continue;
      }
      if (msg.group_id) {
        // v1 不做群聊；这里只记录，不处理。
        skipped += 1;
        continue;
      }

      const from = wxId(msg.from_user_id);
      const wxMessageId = wxId(msg.message_id);
      if (!from || !wxMessageId) {
        skipped += 1;
        continue;
      }

      const createdAt = msg.create_time_ms ? new Date(msg.create_time_ms) : new Date();
      const conversationKey = `dm:${from}`;
      const text = extractText(msg);
      const contextTokenEnc = msg.context_token
        ? encryptSecret(msg.context_token, config.masterKey, "v1")
        : null;

      const userRows = await tx
        .insert(users)
        .values({ accountId, wxUserId: from, lastSeenAt: createdAt })
        .onConflictDoUpdate({
          target: [users.accountId, users.wxUserId],
          set: { lastSeenAt: createdAt },
        })
        .returning({ id: users.id });
      const userId = userRows[0]?.id;

      const rows = await tx
        .insert(messages)
        .values({
          accountId,
          userId,
          conversationKey,
          wxMessageId,
          seq: msg.seq ?? null,
          senderId: from,
          direction: "in",
          messageType: msg.message_type,
          itemType: itemTypeOf(msg.item_list),
          text,
          contextTokenEnc,
          raw: msg as unknown as Record<string, unknown>,
          createdAt,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });

      const row = rows[0];
      if (!row) {
        skipped += 1;
        continue;
      }
      inserted += 1;

      await tx.insert(outbox).values({
        topic: "dm.message",
        payload: { accountId, messageId: String(row.id) },
      });

      if (contextTokenEnc) {
        await tx
          .insert(contextTokens)
          .values({
            accountId,
            conversationKey,
            tokenEnc: contextTokenEnc,
            wxMessageId,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [contextTokens.accountId, contextTokens.conversationKey],
            set: { tokenEnc: contextTokenEnc, wxMessageId, updatedAt: new Date() },
          });
      }
    }

    await tx
      .insert(accountCursors)
      .values({ accountId, buf: nextBuf, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: accountCursors.accountId,
        set: { buf: nextBuf, updatedAt: new Date() },
      });
  });

  return { inserted, skipped };
}
