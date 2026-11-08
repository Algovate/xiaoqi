import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig, MessageRow } from "@xiaoqi/core";
import { buildChartSvg, parseChartCommand, renderChartPng } from "../src/chart.js";
import { handleCommand } from "../src/commands.js";

describe("parseChartCommand", () => {
  it("parses a titled bar chart", () => {
    const result = parseChartCommand("bar 月销量 | 一月=120,二月=180,三月=150");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec).toEqual({
      type: "bar",
      title: "月销量",
      points: [
        { label: "一月", value: 120 },
        { label: "二月", value: 180 },
        { label: "三月", value: 150 },
      ],
    });
  });

  it("supports Chinese aliases and a default title", () => {
    const result = parseChartCommand("饼图 搜索=60,直接=25,其他=15");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.type).toBe("pie");
    expect(result.spec.title).toBe("数据图表");
    expect(result.spec.points).toHaveLength(3);
  });

  it("rejects negative, malformed, and empty data", () => {
    expect(parseChartCommand("bar 一月=-1").ok).toBe(false);
    expect(parseChartCommand("bar 一月").ok).toBe(false);
    expect(parseChartCommand("bar").ok).toBe(false);
    expect(parseChartCommand("scatter 一月=1").ok).toBe(false);
  });
});

describe("buildChartSvg", () => {
  it("escapes text and renders the expected chart type", () => {
    const svg = buildChartSvg({
      type: "line",
      title: "A < B",
      points: [
        { label: "一月", value: 10 },
        { label: "二月", value: 20 },
      ],
    });
    expect(svg).toContain("A &lt; B");
    expect(svg).toContain("<polyline");
    expect(svg).toContain("一月");
    expect(svg).toContain("二月");
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
          points: [
            { label: "A", value: 3 },
            { label: "B", value: 7 },
          ],
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
