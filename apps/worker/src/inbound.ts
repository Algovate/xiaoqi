import { and, desc, eq } from "drizzle-orm";
import type { Database, MessageRow } from "@xiaoqi/core";
import { messages } from "@xiaoqi/core";

const MAX_BURST = 20;
const MAX_AGE_MS = 5_000;

export async function latestInbound(
  db: Database,
  conversationKey: string,
): Promise<MessageRow | null> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationKey, conversationKey), eq(messages.direction, "in")))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return rows[0] ?? null;
}

/** Merge a contiguous inbound burst so file+text is handled as one turn. */
export async function loadInboundBurst(
  db: Database,
  latest: MessageRow,
): Promise<MessageRow> {
  const cutoff = latest.createdAt.getTime() - MAX_AGE_MS;
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationKey, latest.conversationKey))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(MAX_BURST);

  const burst: MessageRow[] = [];
  for (const row of rows) {
    if (row.direction !== "in") break;
    if (row.createdAt.getTime() < cutoff) break;
    burst.push(row);
  }

  return mergeInboundBurst(burst.reverse()) ?? latest;
}

export function mergeInboundBurst(rows: MessageRow[]): MessageRow | null {
  if (rows.length === 0) return null;
  const latest = rows[rows.length - 1]!;
  const texts: string[] = [];
  const items: unknown[] = [];

  for (const row of rows) {
    const text = row.text?.trim();
    if (text && !texts.includes(text)) texts.push(text);
    const raw = row.raw as { item_list?: unknown[] } | null;
    if (raw?.item_list?.length) items.push(...raw.item_list);
  }

  const raw = items.length
    ? { ...(latest.raw as Record<string, unknown> | null), item_list: items }
    : latest.raw;
  return {
    ...latest,
    text: texts.join("\n") || latest.text,
    raw,
  };
}
