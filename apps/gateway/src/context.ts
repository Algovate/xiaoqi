import type { AppConfig, DbHandle } from "@xiaoqi/core";
import { createDb, createLogger, loadConfig } from "@xiaoqi/core";
import type { Logger } from "@xiaoqi/core";

export interface GatewayContext {
  config: AppConfig;
  dbHandle: DbHandle;
  logger: Logger;
  close(): Promise<void>;
}

export function createGatewayContext(): GatewayContext {
  const config = loadConfig();
  const dbHandle = createDb(config.DATABASE_URL);
  const logger = createLogger("gateway", config.LOG_LEVEL);
  return {
    config,
    dbHandle,
    logger,
    async close() {
      await dbHandle.close();
    },
  };
}
