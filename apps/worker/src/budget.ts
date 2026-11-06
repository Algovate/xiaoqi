import type { Pool } from "pg";

export async function dailyTokensUsed(pool: Pool, userId: string): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `
      select coalesce(sum(coalesce(prompt_tokens,0) + coalesce(completion_tokens,0)),0)::text as total
      from runs
      where user_id = $1
        and created_at >= (
          date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'
        )
    `,
    [userId],
  );
  return Number(result.rows[0]?.total ?? 0);
}
