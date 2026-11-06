import { and, desc, eq, gt } from "drizzle-orm";
import type { AppConfig, Database, MessageRow, UserRow } from "@xiaoqi/core";
import { conversationState, messages, reminders } from "@xiaoqi/core";
import { formatShanghai, parseReminder } from "./time.js";
import { chat } from "./llm.js";
import { handleTaskCommand } from "./task-commands.js";

export interface Command {
  name: string;
  args: string;
  raw: string;
}

export const HELP_TEXT = `我是小栖，你的微信 AI 助理。
直接发问题，或发文件让我看。

可用命令：
/summary  总结最近对话
/remind 明天10点 交周报  设置提醒
/codex xiaoqi 修复测试  启动 Codex 任务
/dsh xiaoqi 分析仓库    启动 DSH 任务
/reset    清除上下文
/whoami   查看你的 ID
/help     显示这条帮助`;

export function parseCommand(text: string | null): Command | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/);
  if (!match) return { name: "unknown", args: "", raw: trimmed };
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim(), raw: trimmed };
}

export async function handleCommand(
  deps: { db: Database; config: AppConfig },
  msg: MessageRow,
  user: UserRow | null,
  command: Command,
): Promise<string> {
  switch (command.name) {
    case "help":
      return HELP_TEXT;
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
      return `不认识 /${command.name}。\n\n${HELP_TEXT}`;
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
