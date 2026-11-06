import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

/**
 * 从当前目录向上找 .env，兼容：
 * - root: pnpm db:migrate
 * - apps/gateway: pnpm --filter @xiaoqi/gateway dev
 * - packages/core: pnpm --filter @xiaoqi/core migrate
 */
export function loadEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i += 1) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dotenv.config();
}
