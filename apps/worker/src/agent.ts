import {
  chat,
  type ChatMessage,
  type ChatResult,
  type ChatToolCall,
  type LlmConfig,
  type ToolChoice,
  type ToolDefinition,
} from "./llm.js";

export interface ChatWithToolsResult extends ChatResult {
  rounds: number;
  toolCallCount: number;
}

export interface ChatWithToolsOptions {
  maxModelCalls?: number;
  maxToolCalls?: number;
  firstToolChoice?: ToolChoice;
  temperature?: number;
  maxTokens?: number;
  totalTimeoutMs?: number;
}

const DEFAULT_MAX_MODEL_CALLS = 3;
const DEFAULT_MAX_TOOL_CALLS = 2;
const DEFAULT_TOTAL_TIMEOUT_MS = 90_000;

/**
 * 有界工具循环：模型最多调用 maxToolCalls 次工具、maxModelCalls 次模型。
 * 最后一轮不再提供工具，强制模型给出文字回答。
 */
export async function chatWithTools(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  opts: ChatWithToolsOptions = {},
): Promise<ChatWithToolsResult> {
  const maxModelCalls = Math.max(1, opts.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS);
  const maxToolCalls = Math.max(0, opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS);
  const deadline = Date.now() + (opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  const transcript = [...messages];

  let promptTokens = 0;
  let completionTokens = 0;
  let toolCallCount = 0;
  let lastModel = config.LLM_MODEL;

  for (let round = 0; round < maxModelCalls; round += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("联网搜索超时");

    const isLast = round === maxModelCalls - 1;
    const result = await chat(config, transcript, {
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      tools: isLast ? undefined : tools,
      toolChoice: isLast ? undefined : round === 0 ? (opts.firstToolChoice ?? "auto") : "auto",
      // 命名工具选择不支持 thinking 模式；工具循环统一关闭 thinking，降低延迟。
      thinking: "disabled",
      timeoutMs: Math.min(config.LLM_TIMEOUT_MS, remaining),
    });
    promptTokens += result.promptTokens;
    completionTokens += result.completionTokens;
    lastModel = result.model;

    const textCalls =
      !isLast && result.toolCalls.length === 0 && result.content
        ? parseTextToolCalls(result.content)
        : [];
    const calls = result.toolCalls.length > 0 ? result.toolCalls : textCalls;

    if (!isLast && calls.length > 0) {
      transcript.push({
        role: "assistant",
        content: textCalls.length > 0 ? null : result.content || null,
        tool_calls: calls,
      });

      for (const call of calls) {
        if (toolCallCount >= maxToolCalls) {
          transcript.push({
            role: "tool",
            tool_call_id: call.id,
            content: "已达到本次工具调用上限，未执行。",
          });
          continue;
        }

        toolCallCount += 1;
        let output: string;
        try {
          const args = parseToolArguments(call.function.arguments);
          output = await execute(call.function.name, args);
        } catch (err) {
          output = `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
        }
        transcript.push({ role: "tool", tool_call_id: call.id, content: output });
      }
      continue;
    }

    if (result.content) {
      return {
        content: result.content,
        model: lastModel,
        promptTokens,
        completionTokens,
        finishReason: result.finishReason,
        toolCalls: result.toolCalls,
        rounds: round + 1,
        toolCallCount,
      };
    }

    if (result.toolCalls.length > 0) {
      throw new Error("工具调用次数已达上限，模型未给出回答");
    }
    throw new Error("LLM 返回空内容");
  }

  throw new Error("LLM 工具循环未产生回答");
}

const DSML_INVOKE =
  /<[｜|]{1,2}DSML[｜|]{1,2}\s*invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[｜|]{1,2}DSML[｜|]{1,2}\s*invoke>/gi;
const DSML_ARGUMENTS =
  /<[｜|]{1,2}DSML[｜|]{1,2}\s*parameter\s+name=["']arguments["'][^>]*>([\s\S]*?)<\/[｜|]{1,2}DSML[｜|]{1,2}\s*parameter>/i;

export function parseTextToolCalls(content: string): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  for (const match of content.matchAll(DSML_INVOKE)) {
    const name = match[1]!;
    const argMatch = match[2]!.match(DSML_ARGUMENTS);
    if (!argMatch) continue;
    calls.push({
      id: `dsml-${calls.length}`,
      type: "function",
      function: { name, arguments: argMatch[1]!.trim() },
    });
  }
  return calls;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("参数不是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`工具参数解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
