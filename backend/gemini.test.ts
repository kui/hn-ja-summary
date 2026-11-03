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
}: {
  text?: string;
  headers?: Record<string, string>;
  serviceTier?: string;
} = {}): Response {
  return Response.json(
    {
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        totalTokenCount: 150,
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
    expect(JSON.parse(String(init?.body))).toMatchObject({
      service_tier: "flex",
    });
    // クライアント側の 12 分より前にサーバーが打ち切るよう、余裕を引いた秒数を送る
    const serverTimeout = Number(
      new Headers(init?.headers).get("X-Server-Timeout"),
    );
    expect(serverTimeout).toBeGreaterThan(600);
    expect(serverTimeout).toBeLessThan(12 * 60);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("形式不正なら同じ期限の中で 1 回だけ作り直す", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(geminiOk({ text: "{" }))
      .mockResolvedValueOnce(geminiOk());
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await summarize();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const timeouts = fetchMock.mock.calls.map(([, init]) =>
      Number(new Headers(init?.headers).get("X-Server-Timeout")),
    );
    expect(timeouts[1]).toBeLessThanOrEqual(timeouts[0]!);
  });

  it.each([429, 500, 503, 504])(
    "%i は一時的なエラーとして GeminiUnavailableError を投げる",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("busy", { status }),
      );
      await expect(summarize()).rejects.toThrow(GeminiUnavailableError);
    },
  );

  it("作り直しの呼び出しで起きた一時的なエラーも GeminiUnavailableError になる", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(geminiOk({ text: "{" }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(summarize()).rejects.toThrow(GeminiUnavailableError);
  });

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
