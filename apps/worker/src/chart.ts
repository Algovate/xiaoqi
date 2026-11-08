import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "./llm.js";

const execFileAsync = promisify(execFile);

export type ChartType = "bar" | "line" | "pie";

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  labels: string[];
  series: ChartSeries[];
}

export const RENDER_CHART_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "render_chart",
    description:
      "生成柱状图、折线图或饼图并发送图片。只有用户明确要求画图且提供了标签和数值时调用；不要编造数据。多系列用于对比，例如销量/成本。",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["bar", "line", "pie"], description: "图表类型" },
        title: { type: "string", description: "图表标题，最多 60 字" },
        labels: {
          type: "array",
          description: "横轴标签，1-12 个；饼图最多 8 个",
          items: { type: "string", description: "标签，最多 20 字" },
        },
        series: {
          type: "array",
          description: "数据系列，1-4 个；饼图只能 1 个",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "系列名，最多 20 字" },
              values: {
                type: "array",
                description: "与 labels 一一对应的非负数值",
                items: { type: "number", minimum: 0 },
              },
            },
            required: ["name", "values"],
            additionalProperties: false,
          },
        },
      },
      required: ["type", "title", "labels", "series"],
      additionalProperties: false,
    },
  },
};

export function chartSpecFromTool(args: Record<string, unknown>): ChartSpec | null {
  const type = normalizeType(typeof args.type === "string" ? args.type : "");
  if (!type) return null;

  const rawTitle = typeof args.title === "string" ? args.title.trim().replace(/\s+/g, " ") : "";
  const title = rawTitle ? rawTitle.slice(0, MAX_TITLE_CHARS) : "数据图表";

  const rawLabels = Array.isArray(args.labels) ? args.labels : [];
  if (rawLabels.length === 0 || rawLabels.length > MAX_POINTS) return null;
  const labels: string[] = [];
  for (const raw of rawLabels) {
    if (typeof raw !== "string") return null;
    const label = raw.trim().replace(/\s+/g, " ");
    if (!label || label.length > MAX_LABEL_CHARS) return null;
    labels.push(label);
  }

  const rawSeries = Array.isArray(args.series) ? args.series : [];
  if (rawSeries.length === 0 || rawSeries.length > MAX_SERIES) return null;
  const series: ChartSeries[] = [];
  for (const item of rawSeries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const name =
      typeof record.name === "string" ? record.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > MAX_LABEL_CHARS) return null;
    if (!Array.isArray(record.values) || record.values.length !== labels.length) return null;
    const values: number[] = [];
    for (const raw of record.values) {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
      values.push(raw);
    }
    series.push({ name, values });
  }

  if (type === "pie") {
    if (series.length !== 1 || labels.length > 8) return null;
    if (series[0]!.values.reduce((sum, value) => sum + value, 0) <= 0) return null;
  }

  return { type, title, labels, series };
}

export type ParseChartResult =
  | { ok: true; spec: ChartSpec }
  | { ok: false; error: string };

export const CHART_USAGE = `用法：
/chart bar 月销量 | 一月=120,二月=180,三月=150
/chart bar 销量/成本 | 一月=12/8,二月=18/10 | 销量/成本
/chart line 温度趋势 | 周一=12,周二=14
/chart pie 流量占比 | 搜索=60,直接=25,其他=15`;

const MAX_POINTS = 12;
const MAX_SERIES = 4;
const MAX_TITLE_CHARS = 60;
const MAX_LABEL_CHARS = 20;
const WIDTH = 800;
const HEIGHT = 640;
const MARGIN = { top: 96, right: 36, bottom: 96, left: 72 };
const COLORS = ["#4f7cff", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];

export function parseChartCommand(raw: string): ParseChartResult {
  const input = raw.trim();
  if (!input) return { ok: false, error: CHART_USAGE };

  const segments = input.split("|").map((s) => s.trim());
  if (segments.length > 3) return { ok: false, error: CHART_USAGE };
  const head = segments[0]!;
  const headMatch = head.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!headMatch) return { ok: false, error: CHART_USAGE };

  const type = normalizeType(headMatch[1]!);
  if (!type) return { ok: false, error: `不支持的图表类型：${headMatch[1]}\n\n${CHART_USAGE}` };

  const rest = (headMatch[2] ?? "").trim().replace(/\s+/g, " ");
  const title = segments.length > 1 ? rest : "";
  const dataPart = segments.length > 1 ? (segments[1] ?? "") : rest;
  const seriesPart = segments[2] ?? "";
  if (!dataPart) return { ok: false, error: CHART_USAGE };
  if (title.length > MAX_TITLE_CHARS) {
    return { ok: false, error: `标题太长（最多 ${MAX_TITLE_CHARS} 字）` };
  }

  const parts = dataPart
    .split(/[,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_POINTS) {
    return { ok: false, error: `数据点需要 1-${MAX_POINTS} 个` };
  }

  const rows: Array<{ label: string; values: number[] }> = [];
  for (const part of parts) {
    const match = part.match(/^(.+?)\s*[=:：]\s*(.+)$/);
    if (!match) return { ok: false, error: `看不懂数据：${part}\n\n${CHART_USAGE}` };
    const label = match[1]!.trim().replace(/\s+/g, " ");
    if (!label || label.length > MAX_LABEL_CHARS) {
      return { ok: false, error: `标签需要 1-${MAX_LABEL_CHARS} 字：${label}` };
    }
    const rawValues = match[2]!
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    if (rawValues.length === 0 || rawValues.length > MAX_SERIES) {
      return { ok: false, error: `每个数据点需要 1-${MAX_SERIES} 个数值` };
    }
    const values = rawValues.map(Number);
    if (values.some((v) => !Number.isFinite(v) || v < 0)) {
      return { ok: false, error: "暂不支持负数或非数字" };
    }
    if (rows.length > 0 && rows[0]!.values.length !== values.length) {
      return { ok: false, error: "每一行的数值个数需要一致" };
    }
    rows.push({ label, values });
  }

  const seriesCount = rows[0]!.values.length;
  const seriesNames = seriesPart
    ? seriesPart
        .split(/[/,，、;；]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  if (seriesCount > 1 && seriesNames.length !== seriesCount) {
    return { ok: false, error: "多系列需要写系列名：... | 销量/成本" };
  }
  if (seriesCount === 1 && seriesNames.length > 1) {
    return { ok: false, error: "系列名数量与数值列不一致" };
  }
  const names = seriesCount === 1 ? [seriesNames[0] || "数值"] : seriesNames;
  if (names.some((name) => name.length > MAX_LABEL_CHARS)) {
    return { ok: false, error: `系列名最多 ${MAX_LABEL_CHARS} 字` };
  }

  const labels = rows.map((row) => row.label);
  const series: ChartSeries[] = names.map((name, index) => ({
    name,
    values: rows.map((row) => row.values[index]!),
  }));

  if (type === "pie") {
    if (series.length !== 1) return { ok: false, error: "饼图只支持一个系列" };
    if (labels.length > 8) return { ok: false, error: "饼图最多 8 类" };
    if (series[0]!.values.reduce((sum, value) => sum + value, 0) <= 0) {
      return { ok: false, error: "饼图的总和需要大于 0" };
    }
  }

  return {
    ok: true,
    spec: { type, title: title || "数据图表", labels, series },
  };
}

export function buildChartSvg(spec: ChartSpec): string {
  const title = escapeXml(spec.title);
  const plot = {
    x: MARGIN.left,
    y: MARGIN.top,
    width: WIDTH - MARGIN.left - MARGIN.right,
    height: HEIGHT - MARGIN.top - MARGIN.bottom,
  };
  const body = spec.type === "pie" ? pieChart(spec, plot) : axisChart(spec, plot);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>
  <g font-family="PingFang SC, Heiti SC, Microsoft YaHei, Arial, sans-serif">
    <text x="${MARGIN.left}" y="56" font-size="34" font-weight="600" fill="#111827">${title}</text>
    <text x="${WIDTH - MARGIN.right}" y="${HEIGHT - 20}" text-anchor="end" font-size="14" fill="#9ca3af">小栖生成</text>
    ${body}
  </g>
</svg>`;
}

export async function renderChartPng(
  spec: ChartSpec,
  outputDir: string,
): Promise<{ path: string; mime: string; size: number }> {
  const id = crypto.randomUUID();
  const svgPath = path.join(outputDir, `chart-${id}.svg`);
  const pngPath = path.join(outputDir, `chart-${id}.png`);
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(svgPath, buildChartSvg(spec), "utf8");

  try {
    await execFileAsync("sips", ["-s", "format", "png", "--out", pngPath, svgPath], {
      timeout: 30_000,
      maxBuffer: 1_000_000,
    });
  } catch (err) {
    await fsp.unlink(svgPath).catch(() => undefined);
    throw new Error(`图表渲染失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await fsp.unlink(svgPath).catch(() => undefined);
  }

  const stat = await fsp.stat(pngPath);
  if (!stat.isFile() || stat.size === 0) throw new Error("图表渲染失败：输出为空");
  return { path: pngPath, mime: "image/png", size: stat.size };
}

function normalizeType(raw: string): ChartType | null {
  switch (raw.toLowerCase()) {
    case "bar":
    case "柱状":
    case "柱状图":
      return "bar";
    case "line":
    case "折线":
    case "折线图":
      return "line";
    case "pie":
    case "饼图":
      return "pie";
    default:
      return null;
  }
}

function axisChart(spec: ChartSpec, plot: { x: number; y: number; width: number; height: number }): string {
  const max = niceMax(
    Math.max(...spec.series.flatMap((series) => series.values), 0),
  );
  const ticks = 4;
  const step = plot.width / spec.labels.length;
  const lines: string[] = [];
  const legend = seriesLegend(spec, plot);
  if (legend) lines.push(legend);

  for (let i = 0; i <= ticks; i += 1) {
    const value = (max / ticks) * i;
    const y = plot.y + plot.height - (value / max) * plot.height;
    lines.push(
      `<line x1="${plot.x}" y1="${round(y)}" x2="${plot.x + plot.width}" y2="${round(y)}" stroke="#e5e7eb" stroke-width="1"/>`,
    );
    lines.push(
      `<text x="${plot.x - 14}" y="${round(y + 6)}" text-anchor="end" font-size="18" fill="#6b7280">${formatNumber(value)}</text>`,
    );
  }

  const labelFont = spec.labels.length > 8 ? 16 : 19;

  if (spec.type === "bar") {
    const barWidth =
      spec.series.length === 1
        ? Math.min(step * 0.62, 100)
        : Math.min((step * 0.72) / spec.series.length, 64);
    const gap = spec.series.length > 1 ? 4 : 0;

    spec.labels.forEach((label, i) => {
      const groupCenter = plot.x + step * (i + 0.5);
      const groupWidth = barWidth * spec.series.length + gap * (spec.series.length - 1);
      const start = groupCenter - groupWidth / 2;

      spec.series.forEach((series, j) => {
        const value = series.values[i]!;
        const height = (value / max) * plot.height;
        const x = start + j * (barWidth + gap);
        const y = plot.y + plot.height - height;
        const color = spec.series.length === 1 ? COLORS[i % COLORS.length] : COLORS[j % COLORS.length];
        lines.push(
          `<rect x="${round(x)}" y="${round(y)}" width="${round(barWidth)}" height="${round(Math.max(height, 1))}" rx="6" fill="${color}"/>`,
        );
        if (spec.series.length === 1 || barWidth >= 28) {
          lines.push(
            `<text x="${round(x + barWidth / 2)}" y="${round(y - 8)}" text-anchor="middle" font-size="${spec.series.length === 1 ? 20 : 15}" font-weight="600" fill="#374151">${formatNumber(value)}</text>`,
          );
        }
      });

      lines.push(xLabel(groupCenter, plot.y + plot.height + 34, label, labelFont));
    });
  } else {
    spec.series.forEach((series, j) => {
      const color = COLORS[j % COLORS.length];
      const points = series.values.map((value, i) => {
        const cx = plot.x + step * (i + 0.5);
        const cy = plot.y + plot.height - (value / max) * plot.height;
        return { cx, cy, value };
      });
      lines.push(
        `<polyline points="${points.map((p) => `${round(p.cx)},${round(p.cy)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
      for (const p of points) {
        lines.push(
          `<circle cx="${round(p.cx)}" cy="${round(p.cy)}" r="6" fill="#ffffff" stroke="${color}" stroke-width="3"/>`,
        );
        if (spec.series.length === 1) {
          lines.push(
            `<text x="${round(p.cx)}" y="${round(p.cy - 14)}" text-anchor="middle" font-size="19" font-weight="600" fill="#374151">${formatNumber(p.value)}</text>`,
          );
        }
      }
    });

    spec.labels.forEach((label, i) => {
      const cx = plot.x + step * (i + 0.5);
      lines.push(xLabel(cx, plot.y + plot.height + 34, label, labelFont));
    });
  }

  lines.push(
    `<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#9ca3af" stroke-width="1"/>`,
  );
  return lines.join("\n    ");
}

function seriesLegend(
  spec: ChartSpec,
  plot: { x: number; y: number; width: number; height: number },
): string {
  if (spec.series.length < 2) return "";
  const columnWidth = plot.width / spec.series.length;
  const y = plot.y - 8;
  return spec.series
    .map((series, i) => {
      const x = plot.x + columnWidth * i;
      const label = series.name.length > 8 ? `${series.name.slice(0, 7)}…` : series.name;
      return `<rect x="${round(x)}" y="${y - 16}" width="16" height="16" rx="3" fill="${COLORS[i % COLORS.length]}"/><text x="${round(x + 24)}" y="${y}" font-size="18" fill="#374151">${escapeXml(label)}</text>`;
    })
    .join("\n    ");
}

function pieChart(spec: ChartSpec, plot: { x: number; y: number; width: number; height: number }): string {
  const series = spec.series[0]!;
  const total = series.values.reduce((sum, value) => sum + value, 0);
  const cx = plot.x + plot.width * 0.28;
  const cy = plot.y + plot.height / 2 + 10;
  const radius = 165;
  let angle = -Math.PI / 2;
  const parts: string[] = [];

  series.values.forEach((value, i) => {
    const slice = (value / total) * Math.PI * 2;
    const end = angle + slice;
    const color = COLORS[i % COLORS.length];
    if (series.values.length === 1) {
      parts.push(`<circle cx="${round(cx)}" cy="${round(cy)}" r="${radius}" fill="${color}"/>`);
    } else {
      const x1 = cx + radius * Math.cos(angle);
      const y1 = cy + radius * Math.sin(angle);
      const x2 = cx + radius * Math.cos(end);
      const y2 = cy + radius * Math.sin(end);
      const large = slice > Math.PI ? 1 : 0;
      parts.push(
        `<path d="M ${round(cx)} ${round(cy)} L ${round(x1)} ${round(y1)} A ${radius} ${radius} 0 ${large} 1 ${round(x2)} ${round(y2)} Z" fill="${color}" stroke="#ffffff" stroke-width="2"/>`,
      );
    }

    if (value / total >= 0.06) {
      const mid = angle + slice / 2;
      const lx = cx + radius * 0.62 * Math.cos(mid);
      const ly = cy + radius * 0.62 * Math.sin(mid);
      parts.push(
        `<text x="${round(lx)}" y="${round(ly + 6)}" text-anchor="middle" font-size="18" font-weight="600" fill="#ffffff">${formatPercent(value / total)}</text>`,
      );
    }
    angle = end;
  });

  const legendX = plot.x + plot.width * 0.56;
  const legendTop = plot.y + 64;
  spec.labels.forEach((rawLabel, i) => {
    const value = series.values[i]!;
    const y = legendTop + i * 44;
    parts.push(`<rect x="${round(legendX)}" y="${y - 19}" width="19" height="19" rx="4" fill="${COLORS[i % COLORS.length]}"/>`);
    const label = rawLabel.length > 8 ? `${rawLabel.slice(0, 7)}…` : rawLabel;
    parts.push(
      `<text x="${round(legendX + 30)}" y="${y}" font-size="18" fill="#374151">${escapeXml(label)}</text>`,
    );
    parts.push(
      `<text x="${round(plot.x + plot.width)}" y="${y}" text-anchor="end" font-size="17" fill="#6b7280">${formatNumber(value)} · ${formatPercent(value / total)}</text>`,
    );
  });

  return parts.join("\n    ");
}

function xLabel(cx: number, y: number, label: string, fontSize: number): string {
  const display = label.length > 10 ? `${label.slice(0, 9)}…` : label;
  return `<text x="${round(cx)}" y="${round(y)}" text-anchor="middle" font-size="${fontSize}" fill="#4b5563">${escapeXml(display)}</text>`;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const rough = value / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / power;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * power * 4;
}

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
