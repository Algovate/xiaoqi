import type { Pool } from "pg";
import type { AppConfig, Logger } from "@xiaoqi/core";

interface SchedulerDeps {
  pool: Pool;
  config: AppConfig;
  logger: Logger;
}

export class ReminderScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 20_000);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 50));
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const { pool, config, logger } = this.deps;
      // 进程崩溃时，sending 超过 5 分钟的任务允许重试
      await pool.query(
        "update reminders set status='scheduled' where status='sending' and run_at < now() - interval '5 minutes'",
      );

      const due = await pool.query<{
        id: string;
        account_id: string;
        conversation_key: string;
        text: string;
        run_at: Date;
      }>(`
        with picked as (
          select id from reminders
          where status = 'scheduled' and run_at <= now()
          order by run_at
          limit 20
          for update skip locked
        )
        update reminders r
        set status = 'sending'
        from picked
        where r.id = picked.id
        returning r.id, r.account_id, r.conversation_key, r.text, r.run_at
      `);

      for (const row of due.rows) {
        try {
          const resp = await fetch(`${config.GATEWAY_INTERNAL_URL}/internal/v1/send-proactive`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-xiaoqi-internal": config.internalToken,
            },
            body: JSON.stringify({
              accountId: row.account_id,
              conversationKey: row.conversation_key,
              text: `⏰ 提醒：${row.text}`,
              reminderId: row.id,
            }),
          });
          if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            throw new Error(`http=${resp.status} ${body.slice(0, 200)}`);
          }
          await pool.query("update reminders set status='sent', sent_at=now() where id=$1", [row.id]);
          logger.info({ reminderId: row.id, runAt: row.run_at }, "reminder sent");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await pool.query(
            "update reminders set status='failed', error_code=$2 where id=$1",
            [row.id, message.slice(0, 200)],
          );
          logger.error({ err, reminderId: row.id }, "reminder failed");
        }
      }
    } catch (err) {
      this.deps.logger.error({ err }, "reminder scheduler tick failed");
    } finally {
      this.running = false;
    }
  }
}
