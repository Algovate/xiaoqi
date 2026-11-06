import { createDb, createLogger, loadConfig } from "@xiaoqi/core";
import { ingestPath } from "./kb.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger("kb-ingest", config.LOG_LEVEL);
  const dbHandle = createDb(config.DATABASE_URL);
  const targets = process.argv.slice(2);
  if (targets.length === 0) targets.push("knowledge");

  try {
    for (const target of targets) {
      const done = await ingestPath(dbHandle.db, target);
      logger.info({ target, files: done.length }, "kb ingest done");
      for (const item of done) console.log(`+ ${item}`);
    }
  } finally {
    await dbHandle.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
