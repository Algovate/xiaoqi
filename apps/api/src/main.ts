import { createDb, createLogger, loadConfig } from "@xiaoqi/core";
import { buildApi } from "./server.js";

async function main() {
  const config = loadConfig();
  if (config.ADMIN_TOKEN.length < 8) {
    throw new Error("ADMIN_TOKEN 未配置或太短（至少 8 字符）");
  }
  const logger = createLogger("api", config.LOG_LEVEL);
  const dbHandle = createDb(config.DATABASE_URL);
  const app = await buildApi({ config, dbHandle, logger });

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  logger.info({ port: config.API_PORT }, "admin api listening");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "api shutting down");
    await app.close();
    await dbHandle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
