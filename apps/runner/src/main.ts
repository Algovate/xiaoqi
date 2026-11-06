import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDb, createLogger, loadConfig, type AppConfig, type Logger } from "@xiaoqi/core";

interface Task {
  id: string;
  account_id: string;
  user_id: string | null;
  conversation_key: string;
  repo_alias: string;
  repo_path: string;
  prompt: string;
  status: string;
}

const config = loadConfig();
const logger = createLogger("runner", config.LOG_LEVEL);
const dbHandle = createDb(config.DATABASE_URL);
const pool = dbHandle.pool;

let current: { task: Task; child: ChildProcess } | null = null;
let stopped = false;

async function tick(): Promise<void> {
  if (stopped || current) return;

  // 单 runner：重启后清的 running 视为中断；queued 被 stop 的直接取消。
  await pool.query(
    "update codex_tasks set status='failed', error='runner restarted', finished_at=now() where status='running'",
  );
  await pool.query(
    "update codex_tasks set status='cancelled', finished_at=now() where status='queued' and cancel_requested",
  );

  const picked = await pool.query<Task>(`
    with picked as (
      select id from codex_tasks
      where status = 'queued'
      order by created_at
      limit 1
      for update skip locked
    )
    update codex_tasks t
    set status = 'running', started_at = now()
    from picked
    where t.id = picked.id
    returning t.*
  `);
  const task = picked.rows[0];
  if (!task) return;
  void execute(task);
}

async function execute(task: Task): Promise<void> {
  if (!existsSync(task.repo_path)) {
    await fail(task.id, `仓库路径不存在：${task.repo_path}`);
    return;
  }

  const outFile = path.join(os.tmpdir(), `xiaoqi-codex-${task.id}.txt`);
  const args = [
    "exec",
    "--json",
    "-C",
    task.repo_path,
    "--sandbox",
    "workspace-write",
    "-o",
    outFile,
    task.prompt,
  ];

  logger.info({ taskId: task.id, repo: task.repo_alias }, "codex task started");
  const child = spawn(config.CODEX_BIN, args, {
    cwd: task.repo_path,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  current = { task, child };
  await pool.query("update codex_tasks set pid=$2 where id=$1", [task.id, child.pid ?? null]);

  let stdoutBuf = "";
  let stderr = "";
  let cancelled = false;
  let timedOut = false;
  let sessionId: string | null = null;
  let lastEvent = "";

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, config.CODEX_TIMEOUT_MS);
  timer.unref();

  const cancelPoll = setInterval(() => {
    void pool
      .query<{ cancel_requested: boolean }>("select cancel_requested from codex_tasks where id=$1", [task.id])
      .then((r) => {
        if (r.rows[0]?.cancel_requested) {
          cancelled = true;
          killTree(child);
        }
      })
      .catch(() => undefined);
  }, 2000);
  cancelPoll.unref();

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        sessionId =
          String(event.session_id ?? event.sessionId ?? event.thread_id ?? sessionId ?? "") || null;
        const type = String(event.type ?? (event.msg as { type?: string } | undefined)?.type ?? "event");
        lastEvent = `${type}${summarizeEvent(event)}`.slice(0, 500);
        if (sessionId) {
          void pool.query("update codex_tasks set session_id=$2, last_event=$3 where id=$1", [
            task.id,
            sessionId,
            lastEvent,
          ]);
        } else {
          void pool.query("update codex_tasks set last_event=$2 where id=$1", [task.id, lastEvent]);
        }
        void pool
          .query("insert into codex_task_events(task_id, event_type, payload) values ($1,$2,$3)", [
            task.id,
            type,
            event,
          ])
          .catch(() => undefined);
        logger.debug({ taskId: task.id, event: type }, "codex event");
      } catch {
        lastEvent = line.slice(0, 500);
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });

  child.on("error", (err) => {
    stderr = `${stderr}\n${err.message}`;
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    clearInterval(cancelPoll);
    current = null;

    void (async () => {
      let summary = "";
      try {
        summary = await fsp.readFile(outFile, "utf8");
      } catch {
        summary = "";
      }
      await fsp.rm(outFile, { force: true }).catch(() => undefined);

      const status = cancelled ? "cancelled" : timedOut || code !== 0 ? "failed" : "completed";
      const error = timedOut
        ? `超时（${config.CODEX_TIMEOUT_MS}ms）`
        : code !== 0
          ? stderr.trim().slice(-2000) || `codex exit ${code}`
          : null;

      await pool.query(
        "update codex_tasks set status=$2, summary=$3, error=$4, exit_code=$5, finished_at=now() where id=$1",
        [task.id, status, summary.slice(0, 4000), error, code],
      );
      logger.info({ taskId: task.id, status, code }, "codex task finished");
      await notify(task, status, summary, error);
    })().catch((err) => logger.error({ err, taskId: task.id }, "finish task failed"));
  });
}

async function notify(task: Task, status: string, summary: string, error: string | null): Promise<void> {
  const short = task.id.slice(0, 8);
  const head = status === "completed" ? `✅ Codex 任务 ${short} 完成` : `❌ Codex 任务 ${short} ${status}`;
  const body = summary.trim() || error || "（无输出）";
  const text = `${head}\n仓库：${task.repo_alias}\n\n${body.slice(0, 1200)}`;
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

async function fail(taskId: string, message: string): Promise<void> {
  await pool.query(
    "update codex_tasks set status='failed', error=$2, finished_at=now() where id=$1",
    [taskId, message],
  );
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // ignore
    }
  }, 3000).unref();
}

function summarizeEvent(event: Record<string, unknown>): string {
  const text =
    (event.message as string | undefined) ??
    (event.text as string | undefined) ??
    (event.item as { text?: string } | undefined)?.text ??
    "";
  return text ? `: ${text.replace(/\s+/g, " ").slice(0, 400)}` : "";
}

async function loop(): Promise<void> {
  while (!stopped) {
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, "runner tick failed");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

process.on("SIGINT", () => {
  stopped = true;
  if (current) killTree(current.child);
  setTimeout(() => process.exit(0), 500);
});
process.on("SIGTERM", () => {
  stopped = true;
  if (current) killTree(current.child);
  setTimeout(() => process.exit(0), 500);
});

logger.info({ bin: config.CODEX_BIN }, "codex runner started");
void loop();
