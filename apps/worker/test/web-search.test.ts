import { afterEach, describe, expect, it, vi } from "vitest";
import { formatWebResults, searchWeb } from "../src/web-search.js";

const config = {
  LLM_API_KEY: "sk-test",
  LLM_BASE_URL: "https://api.deepseek.com/v1",
  WEB_SEARCH_ENABLED: true,
  WEB_SEARCH_MAX_RESULTS: 5,
  WEB_SEARCH_TIMEOUT_MS: 1_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchWeb", () => {
  it("calls DeepSeek search with the LLM key and maps results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "上海天气",
              url: "https://example.com/weather",
              summary: "今天多云",
              date: "2026-11-08T00:00:00+00:00",
              site_name: "Example",
              authority: 3,
              rerank_score: 2.1,
            },
            { title: "没有链接", summary: "ignored" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchWeb(config, "上海天气", { oriQuestion: "今天上海天气怎么样" });

    expect(results).toEqual([
      {
        title: "上海天气",
        url: "https://example.com/weather",
        summary: "今天多云",
        date: "2026-11-08T00:00:00+00:00",
        siteName: "Example",
        authority: 3,
        score: 2.1,
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(init.headers.authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual({
      query: "上海天气",
      count: 5,
      need_content: false,
      ori_question: "今天上海天气怎么样",
    });
  });

  it("truncates long queries and clamps count", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await searchWeb(config, "x".repeat(200), { count: 99 });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.query).toHaveLength(128);
    expect(body.count).toBe(10);
  });

  it("surfaces API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 }),
      ),
    );

    await expect(searchWeb(config, "test")).rejects.toThrow("搜索 HTTP 401：invalid key");
  });

  it("refuses when disabled", async () => {
    await expect(
      searchWeb({ ...config, WEB_SEARCH_ENABLED: false }, "test"),
    ).rejects.toThrow("联网搜索未启用");
  });
});

describe("formatWebResults", () => {
  it("numbers sources from an offset with metadata", () => {
    const text = formatWebResults(
      [
        {
          title: "A",
          url: "https://a.example",
          summary: "snippet",
          date: "2026-11-08",
          siteName: "Site",
          authority: 3,
          score: 2,
        },
      ],
      6,
    );

    expect(text).toBe("[6] A\nhttps://a.example\n时间：2026-11-08；站点：Site\nsnippet");
  });
});
