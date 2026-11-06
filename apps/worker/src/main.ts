import http from "node:http";
import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { createDb, createLogger, loadConfig } from "@xiaoqi/core";
import { DM_QUEUE, createDmQueue } from "./queue.js";
import { OutboxDispatcher } from "./outbox.js";
import { createDmHandler } from "./dm-handler.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger("worker", config.LOG_LEVEL);
  const dbHandle = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = createDmQueue(redis);

  const worker = new Worker(DM_QUEUE, createDmHandler({ config, db: dbHandle.db, logger }), {
    connection: redis,
    concurrency: 4,
  });
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "dm job failed");
  });

  const dispatcher = new OutboxDispatcher({ pool: dbHandle.pool, queue, logger });
  dispatcher.start();

  const health = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "worker" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  health.listen(config.WORKER_HEALTH_PORT, "0.0.0.0", () => {
    logger.info({ port: config.WORKER_HEALTH_PORT }, "worker health listening");
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker shutting down");
    await dispatcher.stop();
    await worker.close();
    await queue.close();
    await redis.quit().catch(() => undefined);
    await new Promise<void>((r) => health.close(() => r()));
    await dbHandle.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  logger.info("worker started");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
