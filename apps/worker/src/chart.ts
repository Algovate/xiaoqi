import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "./llm.js";

const execFileAsync = promisify(execFile);

export type ChartType = "bar" | "line" | "pie";

export interface ChartPoint {
  label: string;
  value: number;
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  points: ChartPoint[];
}

export const RENDER_CHART_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "render_chart",
    description:
      "生成柱状图、折线图或饼图并发送图片。只有用户明确要求画图且提供了标签和数值时调用；不要编造数据。",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["bar", "line", "pie"], description: "图表类型" },
        title: { type: "string", description: "图表标题，最多 60 字" },
        data: {
          type: "array",
          description: "数据点，1-12 个；饼图最多 8 个",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "标签，最多 20 字" },
              value: { type: "number", minimum: 0, description: "非负数值" },
            },
            required: ["label", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["type", "title", "data"],
      additionalProperties: false,
    },
  },
};

export function chartSpecFromTool(args: Record<string, unknown>): ChartSpec | null {
  const type = normalizeType(typeof args.type === "string" ? args.type : "");
  if (!type) return null;

  const rawTitle = typeof args.title === "string" ? args.title.trim().replace(/\s+/g, " ") : "";
  const title = rawTitle ? rawTitle.slice(0, MAX_TITLE_CHARS) : "数据图表";
  const rawData = Array.isArray(args.data) ? args.data : [];
  if (rawData.length === 0 || rawData.length > MAX_POINTS) return null;

  const points: ChartPoint[] = [];
  for (const item of rawData) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const label =
      typeof record.label === "string" ? record.label.trim().replace(/\s+/g, " ") : "";
    const value = typeof record.value === "number" ? record.value : Number.NaN;
    if (!label || label.length > MAX_LABEL_CHARS) return null;
    if (!Number.isFinite(value) || value < 0) return null;
    points.push({ label, value });
  }

  if (type === "pie" && points.length > 8) return null;
  if (type === "pie" && points.reduce((sum, p) => sum + p.value, 0) <= 0) return null;

  return { type, title, points };
}

export type ParseChartResult =
  | { ok: true; spec: ChartSpec }
  | { ok: false; error: string };

export const CHART_USAGE = `用法：
/chart bar 月销量 | 一月=120,二月=180,三月=150
/chart line 温度趋势 | 周一=12,周二=14
/chart pie 流量占比 | 搜索=60,直接=25,其他=15`;

const MAX_POINTS = 12;
const MAX_TITLE_CHARS = 60;
const MAX_LABEL_CHARS = 20;
const WIDTH = 800;
const HEIGHT = 640;
const MARGIN = { top: 96, right: 36, bottom: 96, left: 72 };
const COLORS = ["#4f7cff", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];

export function parseChartCommand(raw: string): ParseChartResult {
  const input = raw.trim();
  if (!input) return { ok: false, error: CHART_USAGE };

  const pipe = input.indexOf("|");
  const head = (pipe >= 0 ? input.slice(0, pipe) : input).trim();
  const headMatch = head.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!headMatch) return { ok: false, error: CHART_USAGE };

  const type = normalizeType(headMatch[1]!);
  if (!type) return { ok: false, error: `不支持的图表类型：${headMatch[1]}\n\n${CHART_USAGE}` };

  const rest = (headMatch[2] ?? "").trim().replace(/\s+/g, " ");
  const title = pipe >= 0 ? rest : "";
  const dataPart = (pipe >= 0 ? input.slice(pipe + 1) : rest).trim();
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

  const points: ChartPoint[] = [];
  for (const part of parts) {
    const match = part.match(/^(.+?)\s*[=:：]\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) return { ok: false, error: `看不懂数据：${part}\n\n${CHART_USAGE}` };
    const label = match[1]!.trim().replace(/\s+/g, " ");
    const value = Number(match[2]);
    if (!label || label.length > MAX_LABEL_CHARS) {
      return { ok: false, error: `标签需要 1-${MAX_LABEL_CHARS} 字：${label}` };
    }
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, error: "暂不支持负数或非数字" };
    }
    points.push({ label, value });
  }

  if (type === "pie" && points.length > 8) {
    return { ok: false, error: "饼图最多 8 类" };
  }
  if (type === "pie" && points.reduce((sum, p) => sum + p.value, 0) <= 0) {
    return { ok: false, error: "饼图的总和需要大于 0" };
  }

  return {
    ok: true,
    spec: { type, title: title || "数据图表", points },
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
  const body =
    spec.type === "pie"
      ? pieChart(spec, plot)
      : axisChart(spec, plot);

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
  const values = spec.points.map((p) => p.value);
  const max = niceMax(Math.max(...values, 0));
  const ticks = 4;
  const step = plot.width / spec.points.length;
  const lines: string[] = [];

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

  const labelFont = spec.points.length > 8 ? 16 : 19;

  if (spec.type === "bar") {
    const barWidth = Math.min(step * 0.62, 100);
    spec.points.forEach((point, i) => {
      const cx = plot.x + step * (i + 0.5);
      const height = (point.value / max) * plot.height;
      const x = cx - barWidth / 2;
      const y = plot.y + plot.height - height;
      lines.push(
        `<rect x="${round(x)}" y="${round(y)}" width="${round(barWidth)}" height="${round(Math.max(height, 1))}" rx="6" fill="${COLORS[i % COLORS.length]}"/>`,
      );
      lines.push(
        `<text x="${round(cx)}" y="${round(y - 10)}" text-anchor="middle" font-size="20" font-weight="600" fill="#374151">${formatNumber(point.value)}</text>`,
      );
      lines.push(xLabel(cx, plot.y + plot.height + 34, point.label, labelFont));
    });
  } else {
    const points = spec.points.map((point, i) => {
      const cx = plot.x + step * (i + 0.5);
      const cy = plot.y + plot.height - (point.value / max) * plot.height;
      return { cx, cy, point };
    });
    lines.push(
      `<polyline points="${points.map((p) => `${round(p.cx)},${round(p.cy)}`).join(" ")}" fill="none" stroke="${COLORS[0]}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    for (const p of points) {
      lines.push(`<circle cx="${round(p.cx)}" cy="${round(p.cy)}" r="6" fill="#ffffff" stroke="${COLORS[0]}" stroke-width="3"/>`);
      lines.push(
        `<text x="${round(p.cx)}" y="${round(p.cy - 14)}" text-anchor="middle" font-size="19" font-weight="600" fill="#374151">${formatNumber(p.point.value)}</text>`,
      );
      lines.push(xLabel(p.cx, plot.y + plot.height + 34, p.point.label, labelFont));
    }
  }

  lines.push(
    `<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#9ca3af" stroke-width="1"/>`,
  );
  return lines.join("\n    ");
}

function pieChart(spec: ChartSpec, plot: { x: number; y: number; width: number; height: number }): string {
  const total = spec.points.reduce((sum, p) => sum + p.value, 0);
  const cx = plot.x + plot.width * 0.28;
  const cy = plot.y + plot.height / 2 + 10;
  const radius = 165;
  let angle = -Math.PI / 2;
  const parts: string[] = [];

  spec.points.forEach((point, i) => {
    const slice = (point.value / total) * Math.PI * 2;
    const end = angle + slice;
    const color = COLORS[i % COLORS.length];
    if (spec.points.length === 1) {
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

    if (point.value / total >= 0.06) {
      const mid = angle + slice / 2;
      const lx = cx + radius * 0.62 * Math.cos(mid);
      const ly = cy + radius * 0.62 * Math.sin(mid);
      parts.push(
        `<text x="${round(lx)}" y="${round(ly + 6)}" text-anchor="middle" font-size="18" font-weight="600" fill="#ffffff">${formatPercent(point.value / total)}</text>`,
      );
    }
    angle = end;
  });

  const legendX = plot.x + plot.width * 0.56;
  const legendTop = plot.y + 64;
  spec.points.forEach((point, i) => {
    const y = legendTop + i * 44;
    parts.push(`<rect x="${round(legendX)}" y="${y - 19}" width="19" height="19" rx="4" fill="${COLORS[i % COLORS.length]}"/>`);
    const label = point.label.length > 8 ? `${point.label.slice(0, 7)}…` : point.label;
    parts.push(
      `<text x="${round(legendX + 30)}" y="${y}" font-size="18" fill="#374151">${escapeXml(label)}</text>`,
    );
    parts.push(
      `<text x="${round(plot.x + plot.width)}" y="${y}" text-anchor="end" font-size="17" fill="#6b7280">${formatNumber(point.value)} · ${formatPercent(point.value / total)}</text>`,
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
