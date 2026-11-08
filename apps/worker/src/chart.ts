import type { ToolDefinition } from "./llm.js";

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
  stacked?: boolean;
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
        stacked: {
          type: "boolean",
          description: "仅柱状图：是否把系列堆叠显示",
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

  const stacked = args.stacked === true;
  if (stacked && type !== "bar") return null;

  return { type, title, labels, series, ...(stacked ? { stacked: true } : {}) };
}

export type ParseChartResult =
  | { ok: true; spec: ChartSpec }
  | { ok: false; error: string };

export const CHART_USAGE = `用法：
/chart bar 月销量 | 一月=120,二月=180,三月=150
/chart bar 销量/成本 | 一月=12/8,二月=18/10 | 销量/成本
/chart stacked bar 总量 | 一月=12/8,二月=18/10 | 销量/成本
/chart line 温度趋势 | 周一=12,周二=14
/chart pie 流量占比 | 搜索=60,直接=25,其他=15`;

const MAX_POINTS = 12;
const MAX_SERIES = 4;
const MAX_TITLE_CHARS = 60;
const MAX_LABEL_CHARS = 20;
export function parseChartCommand(raw: string): ParseChartResult {
  const input = raw.trim();
  if (!input) return { ok: false, error: CHART_USAGE };

  const segments = input.split("|").map((s) => s.trim());
  if (segments.length > 3) return { ok: false, error: CHART_USAGE };
  const headParts = segments[0]!.split(/\s+/).filter(Boolean);
  let stacked = false;
  if (headParts[0] === "stacked" || headParts[0] === "堆叠") {
    stacked = true;
    headParts.shift();
  }
  const typeRaw = headParts.shift() ?? "";
  const type = normalizeType(typeRaw);
  if (!type) return { ok: false, error: `不支持的图表类型：${typeRaw}\n\n${CHART_USAGE}` };
  if (stacked && type !== "bar") {
    return { ok: false, error: "堆叠只支持柱状图" };
  }

  const rest = headParts.join(" ").trim().replace(/\s+/g, " ");
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
    spec: {
      type,
      title: title || "数据图表",
      labels,
      series,
      ...(stacked ? { stacked: true } : {}),
    },
  };
}
