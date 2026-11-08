import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig, MessageRow } from "@xiaoqi/core";
import {
  buildChartSvg,
  chartSpecFromTool,
  parseChartCommand,
  renderChartPng,
  RENDER_CHART_TOOL,
} from "../src/chart.js";
import { handleCommand } from "../src/commands.js";

describe("parseChartCommand", () => {
  it("parses a titled bar chart", () => {
    const result = parseChartCommand("bar 月销量 | 一月=120,二月=180,三月=150");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec).toEqual({
      type: "bar",
      title: "月销量",
      labels: ["一月", "二月", "三月"],
      series: [{ name: "数值", values: [120, 180, 150] }],
    });
  });

  it("supports Chinese aliases and a default title", () => {
    const result = parseChartCommand("饼图 搜索=60,直接=25,其他=15");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.type).toBe("pie");
    expect(result.spec.title).toBe("数据图表");
    expect(result.spec.labels).toHaveLength(3);
    expect(result.spec.series[0]!.values).toEqual([60, 25, 15]);
  });

  it("parses multi-series data with names", () => {
    const result = parseChartCommand("bar 销量/成本 | 一月=12/8,二月=18/10 | 销量/成本");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.labels).toEqual(["一月", "二月"]);
    expect(result.spec.series).toEqual([
      { name: "销量", values: [12, 18] },
      { name: "成本", values: [8, 10] },
    ]);
  });

  it("requires names and consistent columns for multi-series", () => {
    expect(parseChartCommand("bar 一月=12/8,二月=18/10").ok).toBe(false);
    expect(parseChartCommand("bar 一月=12/8,二月=18 | 销量/成本").ok).toBe(false);
    expect(parseChartCommand("pie 一月=12/8,二月=18/10 | 销量/成本").ok).toBe(false);
  });

  it("rejects negative, malformed, and empty data", () => {
    expect(parseChartCommand("bar 一月=-1").ok).toBe(false);
    expect(parseChartCommand("bar 一月").ok).toBe(false);
    expect(parseChartCommand("bar").ok).toBe(false);
    expect(parseChartCommand("scatter 一月=1").ok).toBe(false);
  });
});

describe("chartSpecFromTool", () => {
  it("normalizes a valid tool call", () => {
    expect(
      chartSpecFromTool({
        type: "bar",
        title: " 月销量 ",
        labels: ["一月", "二月"],
        series: [{ name: " 销量 ", values: [12, 18] }],
      }),
    ).toEqual({
      type: "bar",
      title: "月销量",
      labels: ["一月", "二月"],
      series: [{ name: "销量", values: [12, 18] }],
    });
  });

  it("rejects invalid tool data", () => {
    expect(chartSpecFromTool({ type: "scatter", labels: ["A"], series: [] })).toBeNull();
    expect(chartSpecFromTool({ type: "bar", labels: [], series: [] })).toBeNull();
    expect(
      chartSpecFromTool({
        type: "bar",
        labels: ["A"],
        series: [{ name: "x", values: [1, 2] }],
      }),
    ).toBeNull();
    expect(
      chartSpecFromTool({
        type: "bar",
        labels: ["A"],
        series: [{ name: "x", values: [-1] }],
      }),
    ).toBeNull();
    expect(
      chartSpecFromTool({
        type: "pie",
        labels: Array.from({ length: 9 }, (_, i) => `L${i}`),
        series: [{ name: "x", values: Array.from({ length: 9 }, () => 1) }],
      }),
    ).toBeNull();
  });

  it("exposes the render_chart tool schema", () => {
    expect(RENDER_CHART_TOOL.function.name).toBe("render_chart");
  });
});

describe("buildChartSvg", () => {
  it("escapes text and renders the expected chart type", () => {
    const svg = buildChartSvg({
      type: "line",
      title: "A < B",
      labels: ["一月", "二月"],
      series: [{ name: "销量", values: [10, 20] }],
    });
    expect(svg).toContain("A &lt; B");
    expect(svg).toContain("<polyline");
    expect(svg).toContain("一月");
    expect(svg).toContain("二月");
  });

  it("renders a legend for multiple series", () => {
    const svg = buildChartSvg({
      type: "bar",
      title: "对比",
      labels: ["一月", "二月"],
      series: [
        { name: "销量", values: [12, 18] },
        { name: "成本", values: [8, 10] },
      ],
    });
    expect(svg).toContain("销量");
    expect(svg).toContain("成本");
    expect(svg.match(/<rect /g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe.skipIf(process.platform !== "darwin")("handleCommand /chart", () => {
  it("renders a chart and sets the media effect", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xiaoqi-chart-cmd-"));
    try {
      const config = {
        MEDIA_DIR: dir,
        MEDIA_OUTBOUND_ENABLED: true,
        MEDIA_OUTBOUND_MAX_BYTES: 5_000_000,
      } as unknown as AppConfig;
      const msg = {
        id: 1,
        accountId: "account",
        conversationKey: "dm:test",
        senderId: "wxid-test",
        userId: null,
      } as unknown as MessageRow;
      const effects: { media?: { path: string; mime: string; filename: string } } = {};

      const text = await handleCommand(
        { db: {} as never, config },
        msg,
        null,
        { name: "chart", args: "bar 月销量 | 一月=120,二月=180", raw: "" },
        effects,
      );

      expect(text).toContain("月销量");
      expect(effects.media?.mime).toBe("image/png");
      expect(effects.media?.path.startsWith(dir)).toBe(true);
      await expect(fsp.stat(effects.media!.path)).resolves.toBeTruthy();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== "darwin")("renderChartPng", () => {
  it("renders a PNG with sips", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xiaoqi-chart-"));
    try {
      const file = await renderChartPng(
        {
          type: "bar",
          title: "渲染测试",
          labels: ["A", "B"],
          series: [{ name: "数值", values: [3, 7] }],
        },
        dir,
      );
      const data = await fsp.readFile(file.path);
      expect(data.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(file.size).toBeGreaterThan(1000);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
