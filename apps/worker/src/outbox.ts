import type { Pool } from "pg";
import type { Logger } from "@xiaoqi/core";
import type { Queue } from "bullmq";

interface DispatchDeps {
  pool: Pool;
  queue: Queue;
  logger: Logger;
}

export class OutboxDispatcher {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running = false;

  constructor(private readonly deps: DispatchDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 50));
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const { pool, queue, logger } = this.deps;
      const picked = await pool.query<{
        id: string;
        topic: string;
        payload: { accountId?: string; messageId?: string };
        attempts: number;
      }>(`
        with picked as (
          select id from outbox
          where status = 'pending' and next_at <= now()
          order by id
          limit 20
          for update skip locked
        )
        update outbox o
        set status = 'processing', attempts = o.attempts + 1
        from picked
        where o.id = picked.id
        returning o.id, o.topic, o.payload, o.attempts
      `);

      for (const row of picked.rows) {
        try {
          if (row.topic !== "dm.message") throw new Error(`unknown outbox topic: ${row.topic}`);
          const { accountId, messageId } = row.payload;
          if (!accountId || !messageId) throw new Error("outbox payload missing ids");
          await queue.add(
            "dm.message",
            { accountId, messageId },
            {
              jobId: `inbound-${accountId}-${messageId}`,
              attempts: 3,
              backoff: { type: "exponential", delay: 2000 },
              removeOnComplete: 1000,
              removeOnFail: 1000,
            },
          );
          await pool.query("update outbox set status = 'done', processed_at = now() where id = $1", [row.id]);
        } catch (err) {
          logger.error({ err, outboxId: row.id }, "outbox dispatch failed");
          const attempts = Number(row.attempts);
          if (attempts >= 10) {
            await pool.query("update outbox set status = 'failed' where id = $1", [row.id]);
          } else {
            await pool.query(
              "update outbox set status = 'pending', next_at = now() + interval '5 seconds' where id = $1",
              [row.id],
            );
          }
        }
      }
    } catch (err) {
      this.deps.logger.error({ err }, "outbox tick failed");
    } finally {
      this.running = false;
    }
  }
}
