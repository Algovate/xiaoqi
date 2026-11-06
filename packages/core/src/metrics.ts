import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const pollUp = new Gauge({
  name: "xiaoqi_poll_up",
  help: "1 if the iLink poller is running",
  labelNames: ["account"],
  registers: [registry],
});

export const inboundTotal = new Counter({
  name: "xiaoqi_inbound_total",
  help: "Inbound batches by result",
  labelNames: ["result"],
  registers: [registry],
});

export const sendTotal = new Counter({
  name: "xiaoqi_send_total",
  help: "Outbound sends by result",
  labelNames: ["result"],
  registers: [registry],
});

export const sendDuration = new Histogram({
  name: "xiaoqi_send_duration_seconds",
  help: "Outbound send duration",
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const runsTotal = new Counter({
  name: "xiaoqi_runs_total",
  help: "Agent runs by final status",
  labelNames: ["status"],
  registers: [registry],
});

export const agentDuration = new Histogram({
  name: "xiaoqi_agent_duration_seconds",
  help: "Agent run duration",
  labelNames: ["model"],
  buckets: [0.5, 1, 2, 5, 10, 20, 40],
  registers: [registry],
});

export const llmTokens = new Counter({
  name: "xiaoqi_llm_tokens_total",
  help: "LLM tokens by type",
  labelNames: ["type"],
  registers: [registry],
});

export const budgetExceeded = new Counter({
  name: "xiaoqi_budget_exceeded_total",
  help: "Times a user hit the daily token budget",
  registers: [registry],
});

export const remindersTotal = new Counter({
  name: "xiaoqi_reminders_total",
  help: "Reminder deliveries by status",
  labelNames: ["status"],
  registers: [registry],
});

export async function metricsText(): Promise<string> {
  return registry.metrics();
}

export const metricsContentType = registry.contentType;
