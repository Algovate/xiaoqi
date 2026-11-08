import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "./llm.js";

const MAX_HTML_BYTES = 300_000;

export const RENDER_HTML_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "render_html",
    description:
      "生成可交互的单文件 HTML 并发送。用于仪表盘、计算器、筛选器、表单、可视化等交互结果；必须自包含，所有 CSS/JS 内联，不使用外部 CDN、字体、图片或网络请求，移动端优先。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "页面标题，最多 40 字" },
        html: {
          type: "string",
          description: "完整 HTML 文档或 body 片段；最多 30 万字符；脚本必须内联",
        },
      },
      required: ["html"],
      additionalProperties: false,
    },
  },
};

export function buildHtmlDocument(raw: string, title = "小栖交互页"): string {
  let doc = raw.trim();
  if (!doc) throw new Error("HTML 为空");

  if (!/<html[\s>]/i.test(doc)) {
    doc = `<!doctype html><html lang="zh-CN"><head><title>${escapeHtml(title)}</title></head><body>${doc}</body></html>`;
  } else if (!/^<!doctype/i.test(doc)) {
    doc = `<!doctype html>\n${doc}`;
  }

  doc = doc
    .replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "")
    .replace(/<meta[^>]+charset=[^>]*>/gi, "")
    .replace(/<meta[^>]+name=["']viewport["'][^>]*>/gi, "");

  const head = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`,
  ].join("");

  if (/<head[\s>]/i.test(doc)) {
    doc = doc.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  } else {
    doc = doc.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
  }

  if (!/<title[\s>]/i.test(doc)) {
    doc = doc.replace(/<head([^>]*)>/i, `<head$1><title>${escapeHtml(title)}</title>`);
  }

  return doc;
}

export async function writeHtmlFile(
  html: string,
  outputDir: string,
): Promise<{ path: string; mime: string; filename: string }> {
  const data = Buffer.from(html, "utf8");
  if (data.length > MAX_HTML_BYTES) {
    throw new Error(`HTML 太大（${data.length} bytes）`);
  }

  await fsp.mkdir(outputDir, { recursive: true });
  const filename = `xiaoqi-interactive-${crypto.randomUUID()}.html`;
  const filePath = path.join(outputDir, filename);
  await fsp.writeFile(filePath, data, { mode: 0o600 });
  return { path: filePath, mime: "text/html", filename };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
