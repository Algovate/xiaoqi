import fsp from "node:fs/promises";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import type { AppConfig, Database, Logger, MessageRow } from "@xiaoqi/core";
import { messages } from "@xiaoqi/core";
import { CHART_USAGE, parseChartCommand } from "./chart.js";
import { renderChartPng } from "./chart-render.js";
import { MERMAID_USAGE, renderMermaidPng } from "./mermaid.js";
import { toCsv } from "./csv.js";
import type { CommandEffects } from "./command-types.js";

const MEDIA_OUTBOUND_DISABLED = "媒体发送未开启：设置 MEDIA_OUTBOUND_ENABLED=true 后重启 worker。";

export async function chartCommand(
  deps: { config: AppConfig; logger?: Logger },
  args: string,
  effects: CommandEffects,
): Promise<string> {
  if (!deps.config.MEDIA_OUTBOUND_ENABLED) return MEDIA_OUTBOUND_DISABLED;
  if (!args.trim()) return CHART_USAGE;

  const parsed = parseChartCommand(args);
  if (!parsed.ok) return parsed.error;

  try {
    const outputDir = path.resolve(deps.config.MEDIA_DIR, "outbound");
    const file = await renderChartPng(parsed.spec, outputDir);
    if (file.size > deps.config.MEDIA_OUTBOUND_MAX_BYTES) {
      await fsp.unlink(file.path).catch(() => undefined);
      return `图表太大（${Math.round(file.size / 1024)}KB），减少数据点再试。`;
    }
    setMediaEffect(effects, file);
    return `图表：${parsed.spec.title}`;
  } catch (err) {
    deps.logger?.warn({ err }, "chart render failed");
    return `图表生成失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function mermaidCommand(
  deps: { config: AppConfig; logger?: Logger },
  args: string,
  effects: CommandEffects,
): Promise<string> {
  if (!deps.config.MEDIA_OUTBOUND_ENABLED) return MEDIA_OUTBOUND_DISABLED;
  if (!deps.config.MERMAID_ENABLED) {
    return "Mermaid 渲染未开启：设置 MERMAID_ENABLED=true 后重启 worker。";
  }
  if (!args.trim()) return MERMAID_USAGE;

  try {
    const outputDir = path.resolve(deps.config.MEDIA_DIR, "outbound");
    const file = await renderMermaidPng(deps.config, args, outputDir);
    setMediaEffect(effects, file);
    return "Mermaid 图已生成。";
  } catch (err) {
    deps.logger?.warn({ err }, "mermaid render failed");
    return `Mermaid 渲染失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function exportCommand(
  deps: { db: Database; config: AppConfig; logger?: Logger },
  msg: MessageRow,
  args: string,
  effects: CommandEffects,
): Promise<string> {
  if (!deps.config.MEDIA_OUTBOUND_ENABLED) return MEDIA_OUTBOUND_DISABLED;
  const arg = args.trim().toLowerCase();
  if (arg && arg !== "csv") {
    return "用法：/export\n导出当前对话最近 500 条消息为 CSV。也可以写 /export csv。";
  }

  const rows = await deps.db
    .select({
      createdAt: messages.createdAt,
      direction: messages.direction,
      itemType: messages.itemType,
      text: messages.text,
    })
    .from(messages)
    .where(eq(messages.conversationKey, msg.conversationKey))
    .orderBy(desc(messages.createdAt))
    .limit(500);

  if (rows.length === 0) return "没有可导出的消息。";

  const csv = `\uFEFF${toCsv(rows.reverse())}`;
  const size = Buffer.byteLength(csv);
  if (size > deps.config.MEDIA_OUTBOUND_MAX_BYTES) {
    return `导出内容太大（${Math.round(size / 1024)}KB），减少消息再试。`;
  }

  try {
    const outputDir = path.resolve(deps.config.MEDIA_DIR, "outbound");
    await fsp.mkdir(outputDir, { recursive: true });
    const filename = `xiaoqi-export-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    const filePath = path.join(outputDir, filename);
    await fsp.writeFile(filePath, csv, { mode: 0o600 });
    effects.file = { path: filePath, mime: "text/csv", filename };
    return `已导出最近 ${rows.length} 条消息为 CSV。`;
  } catch (err) {
    deps.logger?.warn({ err }, "csv export failed");
    return `导出失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

function setMediaEffect(
  effects: CommandEffects,
  file: { path: string; mime: string },
): void {
  effects.media = {
    path: file.path,
    mime: file.mime,
    filename: path.basename(file.path),
  };
}
