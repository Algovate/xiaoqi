import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ilinkBotId: text("ilink_bot_id").notNull(),
    displayName: text("display_name").notNull().default("小栖"),
    tokenEnc: text("token_enc"),
    tokenKid: text("token_kid").notNull().default("v1"),
    baseUrl: text("base_url").notNull().default("https://ilinkai.weixin.qq.com"),
    status: text("status").notNull().default("disabled"),
    lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("accounts_ilink_bot_id_uq").on(t.ilinkBotId)],
);

export const accountCursors = pgTable("account_cursors", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  buf: text("buf").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    wxUserId: text("wx_user_id").notNull(),
    displayName: text("display_name"),
    status: text("status").notNull().default("active"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    settings: jsonb("settings").notNull().default({}),
  },
  (t) => [uniqueIndex("users_account_wx_uq").on(t.accountId, t.wxUserId)],
);

export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    conversationKey: text("conversation_key").notNull(),
    wxMessageId: text("wx_message_id").notNull(),
    seq: bigint("seq", { mode: "number" }),
    senderId: text("sender_id").notNull(),
    direction: text("direction").notNull(),
    messageType: integer("message_type").notNull().default(1),
    itemType: text("item_type").notNull().default("unknown"),
    text: text("text"),
    contextTokenEnc: text("context_token_enc"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    insertedAt: timestamp("inserted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_account_wx_uq").on(t.accountId, t.wxMessageId),
    index("messages_conversation_time_idx").on(t.conversationKey, t.createdAt),
    index("messages_sender_idx").on(t.senderId, t.createdAt),
  ],
);

export const contextTokens = pgTable(
  "context_tokens",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    conversationKey: text("conversation_key").notNull(),
    tokenEnc: text("token_enc").notNull(),
    wxMessageId: text("wx_message_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("context_tokens_uq").on(t.accountId, t.conversationKey)],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    triggerMessageId: bigint("trigger_message_id", { mode: "number" }).references(
      () => messages.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("queued"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms"),
    errorCode: text("error_code"),
    traceId: text("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("runs_trigger_uq").on(t.accountId, t.triggerMessageId),
    index("runs_user_time_idx").on(t.userId, t.createdAt),
  ],
);

export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    wxMessageId: text("wx_message_id"),
    status: text("status").notNull().default("pending"),
    errorCode: text("error_code"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("outbound_run_chunk_uq").on(t.runId, t.chunkIndex)],
);

export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index("outbox_due_idx").on(t.status, t.nextAt)],
);


export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: bigint("message_id", { mode: "number" })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    mime: text("mime"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    storageKey: text("storage_key").notNull(),
    extractedText: text("extracted_text"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("media_message_key_uq").on(t.messageId, t.storageKey)],
);

export const conversationState = pgTable("conversation_state", {
  conversationKey: text("conversation_key").primaryKey(),
  summary: text("summary"),
  summaryTokens: integer("summary_tokens").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AccountRow = typeof accounts.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
