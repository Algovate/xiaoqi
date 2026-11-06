import { Redis } from "ioredis";
import { createGatewayContext } from "./context.js";
import { PollerManager } from "./poller.js";
import { buildServer } from "./server.js";

async function main() {
  const ctx = createGatewayContext();
  const { config, dbHandle, logger } = ctx;
  const { db } = dbHandle;

  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const pollers = new PollerManager({ config, db, redis, logger });
  const server = await buildServer({ config, dbHandle, logger });

  await server.listen({ port: config.GATEWAY_PORT, host: "0.0.0.0" });
  pollers.start();
  logger.info({ port: config.GATEWAY_PORT }, "gateway listening");

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "gateway shutting down");
    await pollers.stop();
    await server.close();
    await redis.quit().catch(() => undefined);
    await ctx.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
