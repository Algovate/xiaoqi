import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "@xiaoqi/core";
import { imageMimeOf } from "@xiaoqi/core";
import type { ToolDefinition } from "./llm.js";

const MAX_CODE_CHARS = 4_000;
const IMAGE_WIDTH = 600;

export const MERMAID_USAGE = `用法：
/mermaid graph TD
  A[用户] --> B[网关]
  B --> C[Worker]
  C --> D[LLM]

也支持 graph LR、sequenceDiagram 等常用 Mermaid 类型。`;

export const RENDER_MERMAID_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "render_mermaid",
    description:
      "把 Mermaid 源码渲染成架构图/流程图/时序图并发送图片。用户明确要求画架构、流程或时序图时调用；code 传完整 Mermaid 源码，优先 graph TD 竖向布局，手机更易读；节点很多时再用 graph LR。",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "完整 Mermaid 源码，最多 4000 字",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
};

export async function renderMermaidPng(
  config: AppConfig,
  rawCode: string,
  outputDir: string,
): Promise<{ path: string; mime: string; size: number }> {
  if (!config.MEDIA_OUTBOUND_ENABLED) throw new Error("图片发送未启用");
  if (!config.MERMAID_ENABLED) throw new Error("Mermaid 渲染未启用");
  const code = rawCode.trim();
  if (!code) throw new Error("Mermaid 源码为空");
  if (code.length > MAX_CODE_CHARS) throw new Error(`Mermaid 源码最多 ${MAX_CODE_CHARS} 字`);

  const encoded = Buffer.from(code, "utf8").toString("base64url");
  const base = config.MERMAID_RENDER_BASE_URL.replace(/\/+$/, "");
  const url = `${base}/img/${encoded}?bgColor=white&type=png&width=${IMAGE_WIDTH}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(config.MERMAID_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new Error(`Mermaid 渲染超时（${config.MERMAID_TIMEOUT_MS}ms）`);
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mermaid 渲染 HTTP ${res.status}：${text.slice(0, 200)}`);
  }

  const data = Buffer.from(await res.arrayBuffer());
  const mime = imageMimeOf(data);
  if (!mime) throw new Error("Mermaid 渲染结果不是图片");
  if (data.length > config.MEDIA_OUTBOUND_MAX_BYTES) {
    throw new Error(`Mermaid 图片过大（${data.length} bytes）`);
  }

  const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "webp";
  await fsp.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `mermaid-${crypto.randomUUID()}.${ext}`);
  await fsp.writeFile(filePath, data);
  return { path: filePath, mime, size: data.length };
}
