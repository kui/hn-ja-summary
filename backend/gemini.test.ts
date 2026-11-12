import { SummaryFormatError } from "@hn-feed/shared/summary";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiUnavailableError, generateSummary, MODEL } from "./gemini.ts";

const VALID_DOC = {
  jaTitle: "日本語タイトル",
  articleHtml: "<p>記事の要約。</p>",
  hnOverviewHtml: "<p>議論の総括。</p>",
  topics: [{ heading: "観点1", bodyHtml: "<ul><li>要点</li></ul>" }],
};

function geminiOk({
  text = JSON.stringify(VALID_DOC),
  headers = {},
  serviceTier = "flex",
  finishReason = "STOP",
  thoughtsTokenCount,
}: {
  text?: string;
  headers?: Record<string, string>;
  serviceTier?: string;
  finishReason?: string;
  thoughtsTokenCount?: number;
} = {}): Response {
  return Response.json(
    {
      candidates: [{ content: { parts: [{ text }] }, finishReason }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount,
        totalTokenCount: 150 + (thoughtsTokenCount ?? 0),
        serviceTier,
      },
    },
    { headers },
  );
}

function summarize() {
  return generateSummary(
    "test-key",
    1,
    "Title",
    "https://example.com/post",
    { status: "ok", content: "本文" },
    ["[alice]: comment"],
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateSummary", () => {
  it("Flex 推論とサーバー側のタイムアウトを指定してモデルを呼ぶ", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        geminiOk({ headers: { "x-gemini-service-tier": "flex" } }),
      );

    const result = await summarize();

    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(`/models/${MODEL}:generateContent`);
    // API キーはトレースに残る URL ではなくヘッダで渡す
    expect(new URL(String(url)).search).toBe("");
    expect(String(url)).not.toContain("test-key");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-key");
    const requestBody = JSON.parse(String(init?.body));
    expect(requestBody).toMatchObject({ service_tier: "flex" });
    // 非推奨のサンプリングパラメータは送らない
    for (const key of ["temperature", "topP", "topK"]) {
      expect(requestBody.generationConfig).not.toHaveProperty(key);
    }
    // 思考量はモデルの既定に任せず明示し、上限は思考の分の余裕を持たせる
    expect(requestBody.generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: "MINIMAL" },
      maxOutputTokens: 8192,
    });
    // クライアント側の 12 分より前にサーバーが打ち切るよう、余裕を引いた秒数を送る
    expect(new Headers(init?.headers).get("X-Server-Timeout")).toBe("690");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(12 * 60 * 1000);
    expect(init?.signal).toBe(timeout.mock.results[0]!.value);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    "%i は一時的なエラーとして GeminiUnavailableError を投げる",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("busy", { status }),
      );
      await expect(summarize()).rejects.toThrow(GeminiUnavailableError);
    },
  );

  it.each([
    ["タイムアウト", new DOMException("timed out", "TimeoutError")],
    ["接続切れ", new TypeError("Network connection lost.")],
  ])("fetch の%sは GeminiUnavailableError になる", async (_, error) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
    await expect(summarize()).rejects.toThrow(GeminiUnavailableError);
  });

  it("本文の読み込み中のタイムアウトも GeminiUnavailableError になる", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new DOMException("timed out", "TimeoutError"));
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    await expect(summarize()).rejects.toThrow(GeminiUnavailableError);
  });

  it("形式不正ならその場で作り直さず SummaryFormatError を投げる", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(geminiOk({ text: "{" }));
    await expect(summarize()).rejects.toThrow(SummaryFormatError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("思考トークンは出力トークンと分けて返す", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      geminiOk({ thoughtsTokenCount: 30 }),
    );
    const result = await summarize();
    expect(result.outputTokens).toBe(50);
    expect(result.thoughtsTokens).toBe(30);
  });

  it("出力上限で途切れたら再試行の対象として SummaryFormatError を投げる", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      geminiOk({ text: '{"jaTitle": "途中', finishReason: "MAX_TOKENS" }),
    );
    await expect(summarize()).rejects.toThrow(SummaryFormatError);
  });

  it.each([
    ["成功", { thoughtsTokenCount: 30 }, "STOP"],
    [
      "出力上限",
      { finishReason: "MAX_TOKENS", thoughtsTokenCount: 30 },
      "MAX_TOKENS",
    ],
    ["形式不正", { text: "{", thoughtsTokenCount: 30 }, "STOP"],
  ])(
    "%sのときもトークン使用量をログに出す",
    async (_, response, finishReason) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(geminiOk(response));
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await summarize().catch(() => {});
      expect(log).toHaveBeenCalledWith(
        `  [gemini] usage: item=1 finishReason=${finishReason} input=100 output=50 thoughts=30`,
      );
    },
  );

  it("安全性フィルタなどで止まったら再試行しないエラーにする", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      geminiOk({ finishReason: "SAFETY" }),
    );
    const err = await summarize().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SummaryFormatError);
    expect(err).not.toBeInstanceOf(GeminiUnavailableError);
  });

  it("その他のエラーステータスは一時的なエラーとして扱わない", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad request", { status: 400 }),
    );
    const err = await summarize().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GeminiUnavailableError);
  });

  it("Flex で処理されなかったら警告を出す", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      geminiOk({ serviceTier: "standard" }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await summarize();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not flex"));
  });

  it("Flex で処理されたら警告を出さない", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(geminiOk());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await summarize();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("generateSummary のリンクの照合", () => {
  it("プロンプトに現れない URL のリンクを外し、外したものをログに出す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      geminiOk({
        text: JSON.stringify({
          ...VALID_DOC,
          articleHtml:
            '<p><a href="https://example.com/post">元記事</a>と<a href="https://evil.test/">偽物</a></p>',
          hnOverviewHtml: '<p><a href="https://comment.test/ref">参照</a></p>',
        }),
      }),
    );

    const result = await generateSummary(
      "test-key",
      1,
      "Title",
      "https://example.com/post",
      { status: "ok", content: "本文" },
      ["[alice]: see https://comment.test/ref"],
    );

    expect(result.summaryHtml).toContain(
      '<a href="https://example.com/post">元記事</a>',
    );
    expect(result.summaryHtml).toContain(
      '<a href="https://comment.test/ref">参照</a>',
    );
    expect(result.summaryHtml).not.toContain("evil.test");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(
      'item=1 field=articleHtml href="https://evil.test/"',
    );
  });
});
