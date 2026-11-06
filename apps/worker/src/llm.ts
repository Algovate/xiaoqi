import type { AppConfig } from "@xiaoqi/core";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export async function chat(
  config: AppConfig,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<ChatResult> {
  if (!config.LLM_API_KEY) {
    throw new Error("LLM_API_KEY 未配置");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: config.LLM_MODEL,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 1200,
        stream: false,
      }),
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
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("LLM 返回空内容");
    return {
      content,
      model: config.LLM_MODEL,
      promptTokens: Number(json.usage?.prompt_tokens ?? 0),
      completionTokens: Number(json.usage?.completion_tokens ?? 0),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`LLM 超时（${config.LLM_TIMEOUT_MS}ms）`);
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
