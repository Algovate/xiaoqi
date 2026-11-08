import { afterEach, describe, expect, it, vi } from "vitest";
import { chatWithTools } from "../src/agent.js";
import type { ToolDefinition } from "../src/llm.js";

const config = {
  LLM_API_KEY: "sk-test",
  LLM_BASE_URL: "https://api.deepseek.com/v1",
  LLM_MODEL: "deepseek-chat",
  LLM_TIMEOUT_MS: 1_000,
};

const tool: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "search",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

function toolCall(id: string, query: string) {
  return {
    id,
    type: "function" as const,
    function: { name: "web_search", arguments: JSON.stringify({ query }) },
  };
}

function llmResponse(
  message: Record<string, unknown>,
  usage = { prompt_tokens: 10, completion_tokens: 2 },
  finish = "stop",
) {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage }), {
    status: 200,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chatWithTools", () => {
  it("executes a tool call then returns the final answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        llmResponse({ content: null, tool_calls: [toolCall("call_1", "上海天气")] }, undefined, "tool_calls"),
      )
      .mockResolvedValueOnce(
        llmResponse(
          { content: "今天多云 [1]\n来源：https://example.com/weather" },
          { prompt_tokens: 20, completion_tokens: 5 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const executed: string[] = [];
    const result = await chatWithTools(
      config,
      [{ role: "user", content: "今天天气怎么样" }],
      [tool],
      async (name, args) => {
        executed.push(`${name}:${args.query}`);
        return "搜索结果";
      },
      { maxModelCalls: 2, maxToolCalls: 2 },
    );

    expect(result.content).toContain("今天多云");
    expect(result.toolCallCount).toBe(1);
    expect(result.rounds).toBe(2);
    expect(result.promptTokens).toBe(30);
    expect(result.completionTokens).toBe(7);
    expect(executed).toEqual(["web_search:上海天气"]);

    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(firstBody.tools).toEqual([tool]);
    expect(firstBody.tool_choice).toBe("auto");
    expect(firstBody.thinking).toEqual({ type: "disabled" });

    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(secondBody.tools).toBeUndefined();
    expect(secondBody.messages).toContainEqual(
      expect.objectContaining({ role: "tool", tool_call_id: "call_1", content: "搜索结果" }),
    );
  });

  it("can force the first tool call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(llmResponse({ content: null, tool_calls: [toolCall("call_1", "x")] }))
      .mockResolvedValueOnce(llmResponse({ content: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await chatWithTools(
      config,
      [{ role: "user", content: "search" }],
      [tool],
      async () => "result",
      {
        maxModelCalls: 2,
        maxToolCalls: 1,
        firstToolChoice: { type: "function", function: { name: "web_search" } },
      },
    );

    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(firstBody.tool_choice).toEqual({
      type: "function",
      function: { name: "web_search" },
    });
  });

  it("skips tool calls beyond the cap but still answers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        llmResponse({
          content: null,
          tool_calls: [toolCall("call_1", "a"), toolCall("call_2", "b")],
        }),
      )
      .mockResolvedValueOnce(llmResponse({ content: "done" }));
    vi.stubGlobal("fetch", fetchMock);

    const executed: string[] = [];
    const result = await chatWithTools(
      config,
      [{ role: "user", content: "q" }],
      [tool],
      async (_name, args) => {
        executed.push(String(args.query));
        return "ok";
      },
      { maxModelCalls: 2, maxToolCalls: 1 },
    );

    expect(executed).toEqual(["a"]);
    expect(result.toolCallCount).toBe(1);
    expect(result.content).toBe("done");

    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    const toolMessages = secondBody.messages.filter(
      (m: { role: string }) => m.role === "tool",
    );
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages).toContainEqual(
      expect.objectContaining({
        tool_call_id: "call_2",
        content: expect.stringContaining("未执行"),
      }),
    );
  });

  it("returns tool errors to the model instead of throwing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(llmResponse({ content: null, tool_calls: [toolCall("call_1", "a")] }))
      .mockResolvedValueOnce(llmResponse({ content: "没查到" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatWithTools(
      config,
      [{ role: "user", content: "q" }],
      [tool],
      async () => {
        throw new Error("boom");
      },
      { maxModelCalls: 2, maxToolCalls: 1 },
    );

    expect(result.content).toBe("没查到");
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(secondBody.messages).toContainEqual(
      expect.objectContaining({ role: "tool", content: "工具执行失败：boom" }),
    );
  });
});
