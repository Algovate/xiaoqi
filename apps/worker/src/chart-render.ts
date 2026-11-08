import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ChartSpec } from "./chart.js";

const execFileAsync = promisify(execFile);

const WIDTH = 800;
const HEIGHT = 640;
const MARGIN = { top: 96, right: 36, bottom: 96, left: 72 };
const COLORS = ["#4f7cff", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];

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
