import { and, desc, eq, gt } from "drizzle-orm";
import type { AppConfig, Database, Logger, MessageRow, UserRow } from "@xiaoqi/core";
import { conversationState, messages, reminders } from "@xiaoqi/core";
import { formatShanghai, parseReminder } from "./time.js";
import { chat } from "./llm.js";
import { handleTaskCommand } from "./task-commands.js";
import { isWebSearchEnabled } from "./web-search.js";
import { chartCommand, exportCommand, mermaidCommand } from "./media-commands.js";
import { helpText } from "./command-registry.js";
import type { CommandEffects } from "./command-types.js";

export interface Command {
  name: string;
  args: string;
  raw: string;
}

export type { CommandEffects } from "./command-types.js";

export function getSearchQuery(command: Command | null): string | null {
  if (!command || command.name !== "search" || !command.args) return null;
  return command.args;
}

export function parseCommand(text: string | null): Command | null {
  if (!text) return null;
  let trimmed = text.trim();
  if (trimmed.startsWith("／")) trimmed = `/${trimmed.slice(1)}`;
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([\p{L}\p{N}_-]+)(?:\s+([\s\S]*))?$/u);
  if (!match) return { name: "unknown", args: "", raw: trimmed };
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim(), raw: trimmed };
}

export async function handleCommand(
  deps: { db: Database; config: AppConfig; logger?: Logger },
  msg: MessageRow,
  user: UserRow | null,
  command: Command,
  effects: CommandEffects = {},
): Promise<string> {
  switch (command.name) {
    case "help":
      return helpText(command.args);
    case "whoami":
      return `你的用户 ID：${msg.senderId}`;
    case "reset":
      await deps.db
        .insert(conversationState)
        .values({ conversationKey: msg.conversationKey, resetAt: new Date(), updatedAt: new Date() })
        .onConflictDoUpdate({
          target: conversationState.conversationKey,
          set: { resetAt: new Date(), summary: null, summaryTokens: 0, updatedAt: new Date() },
        });
      return "已清除当前对话的上下文。";
    case "summary":
      return summarize(deps, msg, user);
    case "search":
      if (!isWebSearchEnabled(deps.config)) {
        return "联网搜索未开启：设置 WEB_SEARCH_ENABLED=true，确认 LLM_API_KEY 已配置后重启 worker。";
      }
      return "用法：/search <问题>\n例：/search 今天上海天气";
    case "chart":
      return chartCommand(deps, command.args, effects);
    case "mermaid":
      return mermaidCommand(deps, command.args, effects);
    case "export":
      return exportCommand(deps, msg, command.args, effects);
    case "codex":
      return handleTaskCommand(deps, msg, command, "codex");
    case "dsh":
      return handleTaskCommand(deps, msg, command, "dsh");
    case "remind": {
      const parsed = parseReminder(command.args);
      if (!parsed) {
        return "时间格式没看懂。试试：\n/remind 明天10点 交周报\n/remind 周五18:00 发版检查\n/remind 30分钟后 喝水";
      }
      await deps.db.insert(reminders).values({
        accountId: msg.accountId,
        userId: msg.userId,
        conversationKey: msg.conversationKey,
        text: parsed.text,
        runAt: parsed.runAt,
      });
      return `已设置提醒：${formatShanghai(parsed.runAt)}\n${parsed.text}`;
    }
    default:
      return `不认识 /${command.name}。\n\n${helpText()}`;
  }
}

async function summarize(
  deps: { db: Database; config: AppConfig },
  msg: MessageRow,
  user: UserRow | null,
): Promise<string> {
  const stateRows = await deps.db
    .select()
    .from(conversationState)
    .where(eq(conversationState.conversationKey, msg.conversationKey))
    .limit(1);
  const resetAt = stateRows[0]?.resetAt;

  const conditions = [eq(messages.conversationKey, msg.conversationKey)];
  if (resetAt) conditions.push(gt(messages.createdAt, resetAt));
  const rows = await deps.db
    .select({ text: messages.text, direction: messages.direction, createdAt: messages.createdAt })
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(80);

  if (rows.length === 0) return "这段对话还没有内容可以总结。";

  const transcript = rows
    .reverse()
    .filter((r) => r.text?.trim())
    .map((r) => `${r.direction === "out" ? "小栖" : "你"}：${r.text}`)
    .join("\n");

  const result = await chat(deps.config, [
    {
      role: "system",
      content:
        "你是对话摘要助手。用中文总结，输出：一句话结论、关键结论、待办/未决问题。不要编造，不要超过 500 字。",
    },
    { role: "user", content: `请总结以下微信私聊：\n\n${transcript.slice(-30_000)}` },
  ]);

  await deps.db
    .insert(conversationState)
    .values({
      conversationKey: msg.conversationKey,
      summary: result.content,
      summaryTokens: result.completionTokens,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: conversationState.conversationKey,
      set: { summary: result.content, summaryTokens: result.completionTokens, updatedAt: new Date() },
    });

  return result.content;
}
