import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyBaseLogger } from "fastify";
import { metricsContentType, metricsText, type AppConfig, type DbHandle, type Logger } from "@xiaoqi/core";

export interface ApiDeps {
  config: AppConfig;
  dbHandle: DbHandle;
  logger: Logger;
}

const HTML_PATH = fileURLToPath(new URL("../public/index.html", import.meta.url));

export async function buildApi(deps: ApiDeps) {
  const { config, dbHandle, logger } = deps;
  const { pool } = dbHandle;
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
  const html = await fsp.readFile(HTML_PATH, "utf8");

  app.get("/", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(html);
  });
  app.get("/healthz", async () => ({ ok: true, service: "api" }));

  app.get("/metrics", async (_req, reply) => {
    return reply.type(metricsContentType).send(await metricsText());
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/v1/")) return;
    if (req.headers["x-admin-token"] !== config.ADMIN_TOKEN) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "invalid admin token" } });
    }
  });

  app.get("/api/v1/overview", async () => {
    const today = await pool.query<{
      users: string;
      messages_today: string;
      runs_today: string;
      tokens_today: string;
      scheduled_reminders: string;
      kb_docs: string;
    }>(`
      select
        (select count(*) from users)::text as users,
        (select count(*) from messages where created_at >= (date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'))::text as messages_today,
        (select count(*) from runs where created_at >= (date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'))::text as runs_today,
        (select coalesce(sum(coalesce(prompt_tokens,0)+coalesce(completion_tokens,0)),0) from runs where created_at >= (date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'))::text as tokens_today,
        (select count(*) from reminders where status='scheduled')::text as scheduled_reminders,
        (select count(*) from kb_documents)::text as kb_docs
    `);
    return today.rows[0];
  });

  app.get("/api/v1/users", async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 50), 200);
    const rows = await pool.query(`
      select u.id, u.wx_user_id, u.display_name, u.status, u.last_seen_at,
        (select count(*) from messages m where m.user_id = u.id)::int as messages,
        (select count(*) from runs r where r.user_id = u.id)::int as runs,
        (select coalesce(sum(coalesce(prompt_tokens,0)+coalesce(completion_tokens,0)),0)
           from runs r where r.user_id = u.id
           and r.created_at >= (date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'))::int as today_tokens
      from users u
      order by u.last_seen_at desc
      limit $1
    `, [limit]);
    return rows.rows;
  });

  app.get("/api/v1/users/:id/messages", async (req) => {
    const id = String((req.params as { id: string }).id);
    const rows = await pool.query(
      `select id, conversation_key, direction, item_type, text, created_at
       from messages where user_id = $1 order by created_at desc limit 100`,
      [id],
    );
    return rows.rows;
  });

  app.get("/api/v1/runs", async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 50), 200);
    const rows = await pool.query(`
      select r.id, r.status, r.model, r.prompt_tokens, r.completion_tokens,
             r.latency_ms, r.error_code, r.created_at, u.wx_user_id
      from runs r left join users u on u.id = r.user_id
      order by r.created_at desc limit $1
    `, [limit]);
    return rows.rows;
  });

  app.get("/api/v1/reminders", async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 50), 200);
    const rows = await pool.query(`
      select r.id, r.text, r.run_at, r.status, r.error_code, u.wx_user_id
      from reminders r left join users u on u.id = r.user_id
      order by r.run_at desc limit $1
    `, [limit]);
    return rows.rows;
  });

  app.get("/api/v1/knowledge", async () => {
    const rows = await pool.query(`
      select d.id, d.title, d.source_path, d.created_at,
        (select count(*) from kb_chunks c where c.document_id = d.id)::int as chunks
      from kb_documents d order by d.created_at desc limit 100
    `);
    return rows.rows;
  });

  app.get("/api/v1/usage", async () => {
    const rows = await pool.query(`
      select (date_trunc('day', created_at at time zone 'Asia/Shanghai'))::date as day,
        count(*)::int as runs,
        coalesce(sum(coalesce(prompt_tokens,0)),0)::int as prompt_tokens,
        coalesce(sum(coalesce(completion_tokens,0)),0)::int as completion_tokens
      from runs
      where created_at >= now() - interval '7 days'
      group by 1 order by 1
    `);
    return rows.rows;
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "api error");
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
  });

  return app;
}
