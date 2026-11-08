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
  ILINK_CDN_BASE: z.string().min(1).default("https://novac2c.cdn.weixin.qq.com/c2c"),

  LLM_BASE_URL: z.string().min(1).default("https://api.deepseek.com/v1"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().min(1).default("deepseek-chat"),
  LLM_VISION_MODEL: z.string().default("deepseek-flash"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  WEB_SEARCH_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  WEB_SEARCH_AUTO: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  WEB_SEARCH_MAX_RESULTS: z.coerce.number().int().positive().default(5),
  WEB_SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  GATEWAY_PORT: z.coerce.number().int().positive().default(4101),
  GATEWAY_INTERNAL_URL: z.string().min(1).default("http://127.0.0.1:4101"),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4102),
  API_PORT: z.coerce.number().int().positive().default(4100),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  ADMIN_TOKEN: z.string().default(""),
  MAX_DAILY_TOKENS: z.coerce.number().int().positive().default(100_000),
  ATTACHMENT_SUMMARY_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  ATTACHMENT_SUMMARY_THRESHOLD_CHARS: z.coerce.number().int().positive().default(20_000),
  ATTACHMENT_SUMMARY_MAX_CHUNKS: z.coerce.number().int().positive().default(8),
  ALERT_WEBHOOK_URL: z.string().default(""),

  CODEX_BIN: z.string().min(1).default("codex"),
  CODEX_REPOS: z.string().default(""),
  CODEX_ALLOWED_USERS: z.string().default(""),
  CODEX_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  DSH_BIN: z.string().min(1).default("dsh"),
  DSH_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),

  WELCOME_MESSAGE: z.string().default(""),
  MEDIA_DIR: z.string().min(1).default("./data/media"),
  MEDIA_OUTBOUND_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  MEDIA_OUTBOUND_MAX_BYTES: z.coerce.number().int().positive().default(5_000_000),
  MERMAID_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  MERMAID_RENDER_BASE_URL: z.string().min(1).default("https://mermaid.ink"),
  MERMAID_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
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
