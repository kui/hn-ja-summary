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

// HN 以外への fetch はすべて other が受ける
function mockFetch(
  other: (url: string) => Response,
  algoliaItem: object = ALGOLIA_ITEM,
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://hn.algolia.com/api/v1/search_by_date")) {
      return Response.json({ hits: [] });
    }
    if (url.startsWith("https://hn.algolia.com/")) {
      return Response.json(algoliaItem);
    }
    return other(url);
  });
}

function geminiSummary(usage: object = {}) {
  const doc = {
    jaTitle: "日本語タイトル",
    articleHtml: "<p>記事の要約。</p>",
    hnOverviewHtml: "<p>議論の総括。</p>",
    topics: [{ heading: "観点1", bodyHtml: "<ul><li>要点</li></ul>" }],
  };
  return Response.json({
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(doc) }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: usage,
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

async function runQueue(attempts: number, testEnv: Env = env as Env) {
  const message = makeMessage(attempts);
  const batch = {
    queue: "hn-processor",
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<{ itemId: number }>;
  // 投げた例外は Worker の外に出て、Queue が再配信する
  const thrown = await queue(batch, testEnv).then(
    () => undefined,
    (e: unknown) => e,
  );
  return { ...message, thrown };
}

async function itemState(): Promise<string | null> {
  return env.DB.prepare("SELECT state FROM processed_items WHERE id = ?")
    .bind(ITEM_ID)
    .first<string>("state");
}

async function storedArticle(): Promise<{
  article_url: string;
  article_fetch_method: string;
} | null> {
  return env.DB.prepare(
    "SELECT article_url, article_fetch_method FROM feed_items WHERE id = ?",
  )
    .bind(ITEM_ID)
    .first();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM processed_items").run();
  await env.DB.prepare("DELETE FROM feed_items").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("queue", () => {
  it.each([
    [429, 1, 60],
    [504, 1, 60],
    // 400 も許可リストにないので再試行する
    [400, 1, 60],
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
    mockFetch(() =>
      geminiSummary({
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 30,
        totalTokenCount: 180,
        serviceTier: "flex",
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

  it("Gemini がプロンプトを安全性フィルタで止めたら再試行せず error にする", async () => {
    mockFetch(() =>
      Response.json({ promptFeedback: { blockReason: "SAFETY" } }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const message = await runQueue(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    expect(await itemState()).toBe("error");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("再試行に回すときはエラーを残し、状態は enqueued のままにする", async () => {
    await env.DB.prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, updated_at_ms)
       VALUES (?, 'enqueued', 1, 1)`,
    )
      .bind(ITEM_ID)
      .run();
    mockFetch(geminiStatus(503));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await runQueue(1);

    const row = await env.DB.prepare(
      "SELECT state, error_message FROM processed_items WHERE id = ?",
    )
      .bind(ITEM_ID)
      .first<{ state: string; error_message: string }>();
    expect(row?.state).toBe("enqueued");
    expect(row?.error_message).toContain("503");
  });

  // 同じ項目のメッセージが 2 つあり、片方が先に成功していた場合
  it("再試行しない失敗でも、completed の項目は error にしない", async () => {
    await env.DB.prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, updated_at_ms)
       VALUES (?, 'completed', 1, 1)`,
    )
      .bind(ITEM_ID)
      .run();
    mockFetch(() =>
      Response.json({ promptFeedback: { blockReason: "SAFETY" } }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const message = await runQueue(1);

    expect(message.ack).toHaveBeenCalled();
    expect(await itemState()).toBe("completed");
  });

  it("再試行しない失敗で D1 に書けなければ、ack せずに例外を投げる", async () => {
    mockFetch(() =>
      Response.json({ promptFeedback: { blockReason: "SAFETY" } }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const brokenDb = {
      prepare() {
        throw new Error("D1 is down");
      },
    };

    const message = await runQueue(2, {
      ...env,
      DB: brokenDb,
    } as unknown as Env);

    expect(message.thrown).toBeInstanceOf(Error);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  // https:example.com はブラウザが href で相対パスとして解決するので、正規化して保存する
  it.each([
    ["https://example.com/article", "https://example.com/article"],
    ["https:example.com/article", "https://example.com/article"],
  ])(
    "記事 URL が %s なら %s を保存し、本文を取得する",
    async (url, articleUrl) => {
      const fetch = mockFetch(
        (url) =>
          url === articleUrl
            ? new Response("<html><body><p>article</p></body></html>", {
                headers: { "Content-Type": "text/html" },
              })
            : geminiSummary(),
        { ...ALGOLIA_ITEM, url },
      );
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const message = await runQueue(1);

      expect(message.ack).toHaveBeenCalled();
      expect(fetch.mock.calls.map(([input]) => String(input))).toContain(
        articleUrl,
      );
      expect((await storedArticle())?.article_url).toBe(articleUrl);
    },
  );

  // リンクとして配信するので、javascript: などを href に入れない
  it.each(["javascript:alert(1)", "data:text/html,<p>x</p>", "not a url"])(
    "記事 URL が %s なら HN の URL にし、本文を取得しない",
    async (url) => {
      const fetch = mockFetch(() => geminiSummary(), {
        ...ALGOLIA_ITEM,
        url,
      });
      vi.spyOn(console, "log").mockImplementation(() => {});

      const message = await runQueue(1);

      expect(message.ack).toHaveBeenCalled();
      const fetched = fetch.mock.calls.map(([input]) => String(input));
      // HN と Gemini 以外には fetch しない
      expect(
        fetched.filter(
          (u) =>
            !u.startsWith("https://hn.algolia.com/") &&
            !u.startsWith("https://generativelanguage.googleapis.com/"),
        ),
      ).toEqual([]);
      // 投稿の本文だけで要約する
      expect(await storedArticle()).toEqual({
        article_url: `https://news.ycombinator.com/item?id=${ITEM_ID}`,
        article_fetch_method: "post_text",
      });
    },
  );

  // skipped にすると poller も再投入しないので、再試行に回す
  it("HN の投稿の取得がタイムアウトしたら skipped にせず再試行する", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("timed out", "TimeoutError"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const message = await runQueue(1);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(await itemState()).toBeNull();
  });
});

const ARTICLE_HTML = `<html><body><article><p>${"記事の本文です。".repeat(30)}</p></article></body></html>`;

async function storedRow(): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(
    `SELECT title, article_url, article_fetch_method, article_chars, comment_count,
            points, comments_used, hn_posted_at_ms
     FROM feed_items WHERE id = ?`,
  )
    .bind(ITEM_ID)
    .first();
}

describe("queue の入力の分岐", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  // 切り詰められた出力は生成し直すと収まることがある
  it("Gemini の出力が MAX_TOKENS で打ち切られたら再試行し、保存しない", async () => {
    mockFetch(() =>
      Response.json({
        candidates: [
          {
            content: { parts: [{ text: '{"jaTitle":"途中' }] },
            finishReason: "MAX_TOKENS",
          },
        ],
      }),
    );

    const message = await runQueue(1);

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(await storedRow()).toBeNull();
    expect(await itemState()).toBeNull();
  });

  it("HN に投稿がなければ skipped にして ack し、Gemini は呼ばない", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.startsWith("https://hn.algolia.com/api/v1/search_by_date")
          ? Response.json({ hits: [] })
          : new Response("not found", { status: 404 });
      });

    const message = await runQueue(1);

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await itemState()).toBe("skipped");
    expect(await storedRow()).toBeNull();
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).startsWith("https://generativelanguage.googleapis.com/"),
      ),
    ).toBe(false);
  });

  it("タイトルがない投稿は「HN Item <ID>」を題にして、点数・コメント数・投稿日時を保存する", async () => {
    mockFetch(() => geminiSummary(), {
      ...ALGOLIA_ITEM,
      title: null,
      points: 7,
      children: [
        {
          id: 10,
          author: "bob",
          text: "<p>これは最初のコメントの本文です。</p>",
          created_at: "2026-01-01T01:00:00Z",
          children: [],
        },
        {
          id: 11,
          author: "carol",
          text: "<p>これは二つ目のコメントの本文です。</p>",
          created_at: "2026-01-01T02:00:00Z",
          children: [],
        },
      ],
    });

    await runQueue(1);

    expect(await storedRow()).toMatchObject({
      title: `HN Item ${ITEM_ID}`,
      points: 7,
      comment_count: 2,
      comments_used: 2,
      hn_posted_at_ms: 1_767_225_600_000,
    });
  });

  it("URL も本文もない投稿は no_url として、文字数を記録しない", async () => {
    mockFetch(() => geminiSummary(), { ...ALGOLIA_ITEM, text: null });

    const message = await runQueue(1);

    expect(message.ack).toHaveBeenCalled();
    expect(await storedRow()).toMatchObject({
      article_url: `https://news.ycombinator.com/item?id=${ITEM_ID}`,
      article_fetch_method: "no_url",
      article_chars: null,
    });
  });

  it("元記事を取得できなければ fetch_failed として、本文なしで要約する", async () => {
    mockFetch(
      (url) =>
        url.startsWith("https://generativelanguage.googleapis.com/")
          ? geminiSummary()
          : new Response("error", { status: 500 }),
      { ...ALGOLIA_ITEM, url: "https://example.com/a", text: null },
    );

    const message = await runQueue(1);

    expect(message.ack).toHaveBeenCalled();
    expect(await storedRow()).toMatchObject({
      article_fetch_method: "fetch_failed",
      article_chars: null,
    });
  });

  it("取得しない既定のサイトは fetch_skipped として、取得を試みない", async () => {
    const fetch = mockFetch(() => geminiSummary(), {
      ...ALGOLIA_ITEM,
      url: "https://www.nytimes.com/a",
      text: null,
    });

    await runQueue(1);

    expect(await storedRow()).toMatchObject({
      article_fetch_method: "fetch_skipped",
      article_chars: null,
    });
    expect(
      fetch.mock.calls.some(([input]) => String(input).includes("nytimes.com")),
    ).toBe(false);
  });

  describe("URL と投稿の本文の両方がある場合", () => {
    const BOTH = { ...ALGOLIA_ITEM, url: "https://example.com/a" };

    it("元記事を取得できれば、投稿の本文のあとにつないで要約する", async () => {
      mockFetch(
        (url) =>
          url === "https://example.com/a"
            ? new Response(ARTICLE_HTML, {
                headers: { "Content-Type": "text/html" },
              })
            : geminiSummary(),
        BOTH,
      );

      await runQueue(1);

      const row = await storedRow();
      expect(row?.article_fetch_method).toBe("raw+post_text");
      // 投稿の本文（post body）だけの長さより長い
      expect(row?.article_chars).toBeGreaterThan("post body".length);
    });

    it("元記事を取得できなければ、投稿の本文だけで要約する", async () => {
      mockFetch(
        (url) =>
          url.startsWith("https://generativelanguage.googleapis.com/")
            ? geminiSummary()
            : new Response("error", { status: 500 }),
        BOTH,
      );

      await runQueue(1);

      expect(await storedRow()).toMatchObject({
        article_fetch_method: "post_text",
        article_chars: "post body".length,
      });
    });

    it("取得しない既定のサイトなら、fetch_skipped を付けて投稿の本文だけで要約する", async () => {
      mockFetch(() => geminiSummary(), {
        ...ALGOLIA_ITEM,
        url: "https://www.nytimes.com/a",
      });

      await runQueue(1);

      expect(await storedRow()).toMatchObject({
        article_fetch_method: "fetch_skipped+post_text",
        article_chars: "post body".length,
      });
    });
  });
});
