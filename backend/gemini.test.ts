import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiUnavailableError, generateSummary, MODEL } from "./gemini.ts";

const VALID_DOC = {
  jaTitle: "日本語タイトル",
  articleHtml: "<p>記事の要約。</p>",
  hnOverviewHtml: "<p>議論の総括。</p>",
  topics: [{ heading: "観点1", bodyHtml: "<ul><li>要点</li></ul>" }],
};

function geminiOk(headers: Record<string, string> = {}): Response {
  return Response.json(
    {
      candidates: [
        {
          content: { parts: [{ text: JSON.stringify(VALID_DOC) }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        totalTokenCount: 150,
        serviceTier: "flex",
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
  it("Flex 推論を指定してモデルを呼ぶ", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(geminiOk({ "x-gemini-service-tier": "flex" }));

    const result = await summarize();

    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(`/models/${MODEL}:generateContent`);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      service_tier: "flex",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([429, 503])(
    "%i は一時的なエラーとして GeminiUnavailableError を投げる",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("busy", { status }),
      );
      await expect(summarize()).rejects.toThrow(GeminiUnavailableError);
    },
  );

  it("タイムアウトは GeminiUnavailableError として投げる", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
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
});
