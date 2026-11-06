import { z } from "zod";
import { loadEnv } from "./env.js";

loadEnv();

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MASTER_KEY: z.string().min(1),
  INTERNAL_TOKEN: z.string().min(8),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  ILINK_BASE_URL: z.string().min(1).default("https://ilinkai.weixin.qq.com"),
  ILINK_APP_ID: z.string().min(1).default("bot"),
  ILINK_APP_VERSION: z.string().min(1).default("132106"),

  LLM_BASE_URL: z.string().min(1).default("https://api.deepseek.com/v1"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().min(1).default("deepseek-chat"),
  LLM_VISION_MODEL: z.string().default("deepseek-flash"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  GATEWAY_PORT: z.coerce.number().int().positive().default(4101),
  GATEWAY_INTERNAL_URL: z.string().min(1).default("http://127.0.0.1:4101"),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4102),
  API_PORT: z.coerce.number().int().positive().default(4100),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  ADMIN_TOKEN: z.string().min(8),
  MAX_DAILY_TOKENS: z.coerce.number().int().positive().default(100_000),
  MEDIA_DIR: z.string().min(1).default("./data/media"),
  OCR_ENABLED: z.enum(["auto", "true", "false"]).default("auto"),
  OCR_BIN: z.string().default(""),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  masterKey: Buffer;
  internalToken: string;
};

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`配置错误：\n${fields}`);
  }

  const masterKey = decodeMasterKey(parsed.data.MASTER_KEY);
  cached = {
    ...parsed.data,
    masterKey,
    internalToken: parsed.data.INTERNAL_TOKEN,
  };
  return cached;
}

function decodeMasterKey(raw: string): Buffer {
  const candidates = [raw, raw.replace(/^base64:/, "")];
  for (const candidate of candidates) {
    try {
      const buf = Buffer.from(candidate, "base64");
      if (buf.length === 32) return buf;
    } catch {
      // ignore
    }
  }
  throw new Error("MASTER_KEY 必须是 32 字节的 base64；生成：openssl rand -base64 32");
}

export function resetConfigForTests(): void {
  cached = null;
}
