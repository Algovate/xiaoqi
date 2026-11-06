import type { AppConfig, Logger } from "@xiaoqi/core";

const sent = new Set<string>();

/** ponytail: 进程内去重，多 worker 实例会重复告警；需要时换 Redis key。 */
export async function maybeAlertBudget(
  config: AppConfig,
  logger: Logger,
  input: { userId: string; used: number; limit: number },
): Promise<void> {
  if (!config.ALERT_WEBHOOK_URL) return;
  const ratio = input.used / input.limit;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

  for (const threshold of [0.5, 0.8, 1]) {
    if (ratio < threshold) continue;
    const key = `${input.userId}:${day}:${threshold}`;
    if (sent.has(key)) continue;
    sent.add(key);

    const content = `⚠️ 小栖预算告警（${Math.round(threshold * 100)}%）\n用户：${input.userId}\n今日已用：${input.used.toLocaleString()} / ${input.limit.toLocaleString()} tokens`;
    try {
      await fetch(config.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content } }),
        signal: AbortSignal.timeout(10_000),
      });
      logger.warn({ userId: input.userId, threshold, used: input.used }, "budget alert sent");
    } catch (err) {
      logger.warn({ err, userId: input.userId, threshold }, "budget alert failed");
    }
  }
}
