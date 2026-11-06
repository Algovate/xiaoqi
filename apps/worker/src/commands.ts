import { and, desc, eq, gt } from "drizzle-orm";
import type { AppConfig, Database, MessageRow, UserRow } from "@xiaoqi/core";
import { codexTasks, conversationState, messages, reminders } from "@xiaoqi/core";
import { parseRepoAllowlist, parseUserAllowlist } from "@xiaoqi/core";
import { formatShanghai, parseReminder } from "./time.js";
import { chat } from "./llm.js";

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
      return codexCommand(deps, msg, command);
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

async function codexCommand(
  deps: { db: Database; config: AppConfig },
  msg: MessageRow,
  command: Command,
): Promise<string> {
  const allowed = parseUserAllowlist(deps.config.CODEX_ALLOWED_USERS);
  if (!allowed.has(msg.senderId)) {
    return "Codex 通道未对你的微信 ID 开放。";
  }
  const repos = parseRepoAllowlist(deps.config.CODEX_REPOS);
  if (repos.size === 0) return "Codex 通道未配置仓库。";

  const args = command.args.trim();
  const [head, ...rest] = args.split(/\s+/).filter(Boolean);

  if (!head || head === "help") {
    return `用法：
/codex <repo> <任务>
/codex resume <id> <追加指令>
/codex list
/codex status <id>
/codex stop <id>

可用仓库：${[...repos.keys()].join(", ")}`;
  }

  if (head === "list") {
    const rows = await deps.db
      .select()
      .from(codexTasks)
      .where(eq(codexTasks.userId, msg.userId ?? ""))
      .orderBy(desc(codexTasks.createdAt))
      .limit(5);
    if (rows.length === 0) return "还没有 Codex 任务。";
    return rows
      .map((t) => `${t.id.slice(0, 8)}  ${t.status}  ${t.repoAlias}\n${t.prompt.slice(0, 80)}`)
      .join("\n\n");
  }

  if (head === "resume") {
    const prefix = rest[0]?.trim();
    const instruction = rest.slice(1).join(" ").trim();
    if (!prefix || !instruction) return "用法：/codex resume <任务ID前8位> <追加指令>";
    const rows = await deps.db
      .select()
      .from(codexTasks)
      .where(eq(codexTasks.userId, msg.userId ?? ""))
      .orderBy(desc(codexTasks.createdAt))
      .limit(50);
    const parent = rows.find((t) => t.id.startsWith(prefix));
    if (!parent) return "没找到这个 Codex 任务。";
    if (!parent.sessionId) return "这个任务没有可 resume 的 Codex session。";
    const inserted = await deps.db
      .insert(codexTasks)
      .values({
        accountId: msg.accountId,
        userId: msg.userId,
        conversationKey: msg.conversationKey,
        repoAlias: parent.repoAlias,
        repoPath: parent.repoPath,
        prompt: instruction,
        kind: "resume",
        resumeSessionId: parent.sessionId,
        status: "queued",
      })
      .returning({ id: codexTasks.id });
    return `已提交 Codex resume：${inserted[0]!.id.slice(0, 8)}\n仓库：${parent.repoAlias}\n追加：${instruction.slice(0, 200)}`;
  }

  if (head === "status" || head === "stop") {
    const prefix = rest.join(" ").trim();
    if (!prefix) return `用法：/codex ${head} <任务ID前 8 位>`;
    const rows = await deps.db
      .select()
      .from(codexTasks)
      .where(eq(codexTasks.userId, msg.userId ?? ""))
      .orderBy(desc(codexTasks.createdAt))
      .limit(50);
    const task = rows.find((t) => t.id.startsWith(prefix));
    if (!task) return "没找到这个 Codex 任务。";
    if (head === "stop") {
      if (!["queued", "running"].includes(task.status)) return `任务已经是 ${task.status}，不用停。`;
      await deps.db
        .update(codexTasks)
        .set({ cancelRequested: true })
        .where(eq(codexTasks.id, task.id));
      return `已请求停止 ${task.id.slice(0, 8)}。`;
    }
    return [
      `任务：${task.id.slice(0, 8)}`,
      `状态：${task.status}`,
      `仓库：${task.repoAlias}`,
      `最后事件：${task.lastEvent ?? "-"}`,
      task.diffStat ? `变更：\n${task.diffStat.slice(0, 500)}` : "",
      task.error ? `错误：${task.error.slice(0, 300)}` : "",
      task.summary ? `结果：${task.summary.slice(0, 800)}` : "",
    ].filter(Boolean).join("\n");
  }

  const repoAlias = head;
  const repoPath = repos.get(repoAlias);
  if (!repoPath) return `仓库 ${repoAlias} 不在 allowlist。可用：${[...repos.keys()].join(", ")}`;
  const prompt = rest.join(" ").trim();
  if (!prompt) return "任务内容不能为空。";

  const rows = await deps.db
    .insert(codexTasks)
    .values({
      accountId: msg.accountId,
      userId: msg.userId,
      conversationKey: msg.conversationKey,
      repoAlias,
      repoPath,
      prompt,
      status: "queued",
    })
    .returning({ id: codexTasks.id });
  const id = rows[0]!.id;
  return `已提交 Codex 任务：${id.slice(0, 8)}\n仓库：${repoAlias}\n任务：${prompt.slice(0, 200)}\n完成后我会通知你。`;
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
