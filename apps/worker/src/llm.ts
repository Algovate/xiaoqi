import type { AppConfig } from "@xiaoqi/core";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolChoice = "auto" | "none" | { type: "function"; function: { name: string } };

export interface ChatResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string | null;
  toolCalls: ChatToolCall[];
}

export type LlmConfig = Pick<
  AppConfig,
  "LLM_API_KEY" | "LLM_BASE_URL" | "LLM_MODEL" | "LLM_TIMEOUT_MS"
>;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ChatToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  thinking?: "enabled" | "disabled";
  timeoutMs?: number;
}

export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  if (!config.LLM_API_KEY) {
    throw new Error("LLM_API_KEY 未配置");
  }

  const timeoutMs = opts.timeoutMs ?? config.LLM_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: config.LLM_MODEL,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1200,
      stream: false,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.toolChoice ?? "auto";
    }
    if (opts.thinking) {
      body.thinking = { type: opts.thinking };
    }

    const res = await fetch(`${config.LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: ChatCompletionResponse;
    try {
      json = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new Error(`LLM 返回非 JSON：${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`LLM HTTP ${res.status}：${json.error?.message ?? text.slice(0, 200)}`);
    }

    const choice = json.choices?.[0];
    const content = choice?.message?.content?.trim() ?? "";
    const toolCalls = choice?.message?.tool_calls ?? [];
    if (!content && toolCalls.length === 0) throw new Error("LLM 返回空内容");

    return {
      content,
      model: config.LLM_MODEL,
      promptTokens: Number(json.usage?.prompt_tokens ?? 0),
      completionTokens: Number(json.usage?.completion_tokens ?? 0),
      finishReason: choice?.finish_reason ?? null,
      toolCalls,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`LLM 超时（${timeoutMs}ms）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface VisionResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * DeepSeek V4 Flash 支持 image input；走 OpenAI-compatible image_url content。
 * 失败时抛错，调用方回退本地 OCR。
 */
export async function describeImage(
  config: AppConfig,
  image: Buffer,
  mime: string,
): Promise<VisionResult> {
  if (!config.LLM_API_KEY) throw new Error("LLM_API_KEY 未配置");
  if (!config.LLM_VISION_MODEL) throw new Error("LLM_VISION_MODEL 未配置");
  if (image.length > 8 * 1024 * 1024) throw new Error("图片超过 8MB，跳过视觉模型");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(config.LLM_TIMEOUT_MS, 90_000));
  try {
    const res = await fetch(`${config.LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: config.LLM_VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "请用中文描述这张图片中与用户问题相关的信息。优先提取：界面文字、报错信息、表格数字、流程关系、关键按钮。看不清就说看不清；不要编造。最多 350 字。",
              },
              {
                type: "image_url",
                image_url: { url: `data:${mime};base64,${image.toString("base64")}` },
              },
            ],
          },
        ],
        temperature: 0.2,
        max_tokens: 1500,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: ChatCompletionResponse;
    try {
      json = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new Error(`视觉模型返回非 JSON：${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`视觉模型 HTTP ${res.status}：${json.error?.message ?? text.slice(0, 200)}`);
    }
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("视觉模型返回空内容");
    return {
      text: content,
      model: config.LLM_VISION_MODEL,
      promptTokens: Number(json.usage?.prompt_tokens ?? 0),
      completionTokens: Number(json.usage?.completion_tokens ?? 0),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("视觉模型超时");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
