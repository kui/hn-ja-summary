import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queue } from "./processor.ts";

const ITEM_ID = 1;

// 本文付きの Ask HN 形式にして元記事の取得を省き、Gemini 呼び出しまで進める
const ALGOLIA_ITEM = {
  id: ITEM_ID,
  title: "Ask HN: Test",
  url: null,
  text: "post body",
  author: "alice",
  points: 10,
  created_at: "2026-01-01T00:00:00Z",
  children: [],
};

function mockFetch(gemini: () => Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("https://hn.algolia.com/")) {
      return Response.json(ALGOLIA_ITEM);
    }
    return gemini();
  });
}

function geminiStatus(status: number) {
  return () => new Response("error", { status });
}

function makeMessage(attempts: number) {
  return {
    id: "msg",
    body: { itemId: ITEM_ID },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function runQueue(attempts: number) {
  const message = makeMessage(attempts);
  const batch = {
    queue: "hn-processor",
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<{ itemId: number }>;
  await queue(batch, env as Env);
  return message;
}

async function itemState(): Promise<string | null> {
  return env.DB.prepare("SELECT state FROM processed_items WHERE id = ?")
    .bind(ITEM_ID)
    .first<string>("state");
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM processed_items").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("queue", () => {
  it.each([
    [429, 1, 60],
    [504, 1, 60],
    [503, 3, 240],
    // max_retries = 6 なので、再試行を予約する最後の配信は attempts=6
    [503, 6, 1920],
  ])(
    "Gemini が %i を返したら attempts=%i で %i 秒後に再試行する",
    async (status, attempts, delaySeconds) => {
      mockFetch(geminiStatus(status));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const message = await runQueue(attempts);
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds });
      expect(message.ack).not.toHaveBeenCalled();
      expect(await itemState()).toBeNull();
    },
  );

  it("要約できたらトークン数を出力と思考に分けて記録する", async () => {
    const doc = {
      jaTitle: "日本語タイトル",
      articleHtml: "<p>記事の要約。</p>",
      hnOverviewHtml: "<p>議論の総括。</p>",
      topics: [{ heading: "観点1", bodyHtml: "<ul><li>要点</li></ul>" }],
    };
    mockFetch(() =>
      Response.json({
        candidates: [
          {
            content: { parts: [{ text: JSON.stringify(doc) }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          thoughtsTokenCount: 30,
          totalTokenCount: 180,
          serviceTier: "flex",
        },
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const message = await runQueue(1);
    expect(message.ack).toHaveBeenCalled();
    const row = await env.DB.prepare(
      "SELECT input_tokens, output_tokens, thoughts_tokens FROM feed_items WHERE id = ?",
    )
      .bind(ITEM_ID)
      .first();
    expect(row).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      thoughts_tokens: 30,
    });
  });

  it("出力の形式が不正なら再試行する", async () => {
    mockFetch(() =>
      Response.json({
        candidates: [
          { content: { parts: [{ text: "{" }] }, finishReason: "STOP" },
        ],
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const message = await runQueue(1);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(await itemState()).toBeNull();
  });

  it("一時的でないエラーは再試行せず ack する", async () => {
    mockFetch(geminiStatus(400));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = await runQueue(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    expect(await itemState()).toBe("error");
    expect(error).toHaveBeenCalledTimes(1);
  });
});
