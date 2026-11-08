import { and, desc, eq, gt } from "drizzle-orm";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AppConfig, Database, Logger, MessageRow, UserRow } from "@xiaoqi/core";
import { conversationState, messages, reminders } from "@xiaoqi/core";
import { formatShanghai, parseReminder } from "./time.js";
import { chat } from "./llm.js";
import { handleTaskCommand } from "./task-commands.js";
import { isWebSearchEnabled } from "./web-search.js";
import { CHART_USAGE, parseChartCommand, renderChartPng } from "./chart.js";

export interface Command {
  name: string;
  args: string;
  raw: string;
}

export interface CommandEffects {
  media?: { path: string; mime: string; filename: string };
}

export const HELP_TEXT = `我是小栖，你的微信 AI 助理。
直接发问题，或发文件让我看。

可用命令：
/summary  总结最近对话
/search 今天上海天气     联网搜索并回答
/chart bar 月销量 | 一月=120,二月=180  生成图表
/remind 明天10点 交周报  设置提醒
/codex xiaoqi 修复测试  启动 Codex 任务
/dsh xiaoqi 分析仓库    启动 DSH 任务
/reset    清除上下文
/whoami   查看你的 ID
/help     显示这条帮助

问最新消息、天气、价格等时效问题时，我会自动联网搜索；也可以 /search 强制。`;

export function getSearchQuery(command: Command | null): string | null {
  if (!command || command.name !== "search" || !command.args) return null;
  return command.args;
}

export function parseCommand(text: string | null): Command | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/);
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
    case "search":
      if (!isWebSearchEnabled(deps.config)) {
        return "联网搜索未开启：设置 WEB_SEARCH_ENABLED=true，确认 LLM_API_KEY 已配置后重启 worker。";
      }
      return "用法：/search <问题>\n例：/search 今天上海天气";
    case "chart":
      return chartCommand(deps, command.args, effects);
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

async function chartCommand(
  deps: { config: AppConfig; logger?: Logger },
  args: string,
  effects: CommandEffects,
): Promise<string> {
  if (!deps.config.MEDIA_OUTBOUND_ENABLED) {
    return "发图能力未开启：设置 MEDIA_OUTBOUND_ENABLED=true 后重启 worker。";
  }
  if (!args.trim()) return CHART_USAGE;

  const parsed = parseChartCommand(args);
  if (!parsed.ok) return parsed.error;

  try {
    const outputDir = path.resolve(deps.config.MEDIA_DIR, "outbound");
    const file = await renderChartPng(parsed.spec, outputDir);
    if (file.size > deps.config.MEDIA_OUTBOUND_MAX_BYTES) {
      await fsp.unlink(file.path).catch(() => undefined);
      return `图表太大（${Math.round(file.size / 1024)}KB），减少数据点再试。`;
    }
    effects.media = { path: file.path, mime: file.mime, filename: path.basename(file.path) };
    return `图表：${parsed.spec.title}`;
  } catch (err) {
    deps.logger?.warn({ err }, "chart render failed");
    return `图表生成失败：${err instanceof Error ? err.message : String(err)}`;
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
