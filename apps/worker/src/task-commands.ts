import { and, desc, eq } from "drizzle-orm";
import type { AppConfig, Database, MessageRow } from "@xiaoqi/core";
import { codexTasks, parseRepoAllowlist, parseUserAllowlist } from "@xiaoqi/core";
import type { Command } from "./commands.js";

export async function handleTaskCommand(
  deps: { db: Database; config: AppConfig },
  msg: MessageRow,
  command: Command,
  engine: "codex" | "dsh",
): Promise<string> {
  const prefix = `/${engine}`;
  const allowed = parseUserAllowlist(deps.config.CODEX_ALLOWED_USERS);
  if (!allowed.has(msg.senderId)) {
    return `${engine.toUpperCase()} 通道未对你的微信 ID 开放。`;
  }
  const repos = parseRepoAllowlist(deps.config.CODEX_REPOS);
  if (repos.size === 0) return `${engine.toUpperCase()} 通道未配置仓库。`;

  const args = command.args.trim();
  const [head, ...rest] = args.split(/\s+/).filter(Boolean);

  if (!head || head === "help") {
    const resume = engine === "codex" ? `${prefix} resume <id> <追加指令>\n` : "";
    return `用法：
${prefix} <repo> <任务>
${resume}${prefix} list
${prefix} status <id>
${prefix} stop <id>

可用仓库：${[...repos.keys()].join(", ")}`;
  }

  if (head === "list") {
    const rows = await deps.db
      .select()
      .from(codexTasks)
      .where(and(eq(codexTasks.userId, msg.userId ?? ""), eq(codexTasks.engine, engine)))
      .orderBy(desc(codexTasks.createdAt))
      .limit(5);
    if (rows.length === 0) return `还没有 ${engine === "codex" ? "Codex" : "DSH"} 任务。`;
    return rows
      .map((t) => `${t.id.slice(0, 8)}  ${t.status}  ${t.repoAlias}\n${t.prompt.slice(0, 80)}`)
      .join("\n\n");
  }

  if (head === "resume") {
    if (engine !== "codex") return `/${engine} 不支持 resume。`;
    const idPrefix = rest[0]?.trim();
    const instruction = rest.slice(1).join(" ").trim();
    if (!idPrefix || !instruction) return `用法：${prefix} resume <任务ID前8位> <追加指令>`;
    const rows = await deps.db
      .select()
      .from(codexTasks)
      .where(and(eq(codexTasks.userId, msg.userId ?? ""), eq(codexTasks.engine, engine)))
      .orderBy(desc(codexTasks.createdAt))
      .limit(50);
    const parent = rows.find((t) => t.id.startsWith(idPrefix));
    if (!parent) return `没找到这个 ${engine === "codex" ? "Codex" : "DSH"} 任务。`;
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
        engine,
        kind: "resume",
        resumeSessionId: parent.sessionId,
        status: "queued",
      })
      .returning({ id: codexTasks.id });
    return `已提交 ${engine === "codex" ? "Codex" : "DSH"} resume：${inserted[0]!.id.slice(0, 8)}\n仓库：${parent.repoAlias}\n追加：${instruction.slice(0, 200)}`;
  }

  if (head === "status" || head === "stop") {
    const idPrefix = rest.join(" ").trim();
    if (!idPrefix) return `用法：${prefix} ${head} <任务ID前 8 位>`;
    const rows = await deps.db
      .select()
      .from(codexTasks)
      .where(and(eq(codexTasks.userId, msg.userId ?? ""), eq(codexTasks.engine, engine)))
      .orderBy(desc(codexTasks.createdAt))
      .limit(50);
    const task = rows.find((t) => t.id.startsWith(idPrefix));
    if (!task) return `没找到这个 ${engine === "codex" ? "Codex" : "DSH"} 任务。`;
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
      engine,
      status: "queued",
    })
    .returning({ id: codexTasks.id });
  const id = rows[0]!.id;
  return `已提交 ${engine === "codex" ? "Codex" : "DSH"} 任务：${id.slice(0, 8)}\n仓库：${repoAlias}\n任务：${prompt.slice(0, 200)}\n完成后我会通知你。`;
}

