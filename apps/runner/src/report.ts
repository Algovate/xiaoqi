import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig, Logger } from "@xiaoqi/core";
import type { Task } from "./types.js";

const execFileAsync = promisify(execFile);

export async function gitDiff(repoPath: string): Promise<string> {
  try {
    const [{ stdout: stat }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["-C", repoPath, "diff", "--stat"], { timeout: 10_000, maxBuffer: 200_000 }),
      execFileAsync("git", ["-C", repoPath, "status", "--short"], { timeout: 10_000, maxBuffer: 200_000 }),
    ]);
    return [stat.trim(), status.trim()].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

export async function notify(
  config: AppConfig,
  logger: Logger,
  task: Task,
  status: string,
  summary: string,
  error: string | null,
  diffStat: string,
): Promise<void> {
  const short = task.id.slice(0, 8);
  const label = task.engine === "dsh" ? "DSH" : "Codex";
  const head = status === "completed" ? `✅ ${label} 任务 ${short} 完成` : `❌ ${label} 任务 ${short} ${status}`;
  const body = summary.trim() || error || "（无输出）";
  const diff = diffStat.trim() ? `\n\n变更：\n${diffStat.trim().slice(0, 800)}` : "";
  const text = `${head}\n仓库：${task.repo_alias}\n\n${body.slice(0, 1200)}${diff}`;

  try {
    const res = await fetch(`${config.GATEWAY_INTERNAL_URL}/internal/v1/send-proactive`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xiaoqi-internal": config.internalToken,
      },
      body: JSON.stringify({
        accountId: task.account_id,
        conversationKey: task.conversation_key,
        text,
      }),
    });
    if (!res.ok) logger.warn({ taskId: task.id, status: res.status }, "task notify failed");
  } catch (err) {
    logger.warn({ err, taskId: task.id }, "task notify error");
  }
}

export function summarizeEvent(event: Record<string, unknown>): string {
  const text =
    (event.message as string | undefined) ??
    (event.text as string | undefined) ??
    (event.item as { text?: string } | undefined)?.text ??
    "";
  return text ? `: ${text.replace(/\s+/g, " ").slice(0, 400)}` : "";
}
