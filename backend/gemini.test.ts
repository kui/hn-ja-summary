import { SummaryFormatError } from "./summary.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiRejectedError,
  generateSummary,
  MODEL,
  parseSummaryResponse,
} from "./gemini.ts";

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
    // 許可タグの一覧は ALLOWED_TAGS の並びから作るので、プロンプトの文字列が変わっていないことを固定する
    expect(
      requestBody.generationConfig.responseSchema.properties.hnOverviewHtml
        .description,
    ).toContain(
      "見出しタグは含めない。使用可能なタグは p, ul, ol, li, strong, em, code, sup, sub, a, table, thead, tbody, tr, th, td, br のみ。開いたタグは必ず閉じる。",
    );
    // クライアント側の 12 分より前にサーバーが打ち切るよう、余裕を引いた秒数を送る
    expect(new Headers(init?.headers).get("X-Server-Timeout")).toBe("690");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(12 * 60 * 1000);
    expect(init?.signal).toBe(timeout.mock.results[0]!.value);
  });

  it("外部入力を囲む区切り文字は呼ぶたびに変える", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => geminiOk());

    await summarize();
    await summarize();

    const ids = fetchMock.mock.calls.map(([, init]) => {
      const prompt: string = JSON.parse(String(init?.body)).contents[0].parts[0]
        .text;
      const id = /<<<ARTICLE_START_([0-9a-f]{16})>>>/.exec(prompt)?.[1];
      for (const mark of ["ARTICLE_END", "COMMENTS_START", "COMMENTS_END"]) {
        expect(prompt).toContain(`<<<${mark}_${id}>>>`);
      }
      return id;
    });
    expect(ids[0]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
  });

  it.each([400, 408, 429, 500, 503, 504])(
    "%i は再試行の対象として GeminiRejectedError 以外を投げる",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("busy", { status }),
      );
      const err = await summarize().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(GeminiRejectedError);
      // error_message に残るので、どの API のどのステータスかが分かるようにする
      expect(String(err)).toContain(`Gemini API error: ${status}`);
    },
  );

  it.each([
    ["タイムアウト", new DOMException("timed out", "TimeoutError")],
    ["接続切れ", new TypeError("Network connection lost.")],
  ])("fetch の%sは再試行の対象になる", async (_, error) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
    const err = await summarize().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GeminiRejectedError);
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

  it.each([
    "SAFETY",
    "RECITATION",
    "LANGUAGE",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
  ])(
    "出力が %s で止められても、生成し直せば通りうるので再試行の対象にする",
    async (finishReason) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        geminiOk({ finishReason }),
      );
      const err = await summarize().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(GeminiRejectedError);
    },
  );

  it.each(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT"])(
    "プロンプトが %s で止められたら再試行しない GeminiRejectedError を投げる",
    async (blockReason) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ promptFeedback: { blockReason } }),
      );
      await expect(summarize()).rejects.toThrow(GeminiRejectedError);
    },
  );

  it.each([
    ["OTHER で止まった出力", { candidates: [{ finishReason: "OTHER" }] }],
    [
      "理由が不明なプロンプトの拒否",
      { promptFeedback: { blockReason: "OTHER" } },
    ],
  ])("%sは許可リストにないので再試行の対象になる", async (_, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    const err = await summarize().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GeminiRejectedError);
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

    expect(result.doc.article).toEqual({
      status: "ok",
      html: '<p><a href="https://example.com/post">元記事</a>と偽物</p>',
    });
    expect(result.doc.hnOverviewHtml).toBe(
      '<p><a href="https://comment.test/ref">参照</a></p>',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(
      'item=1 field=articleHtml href="https://evil.test/"',
    );
  });

  it("本文が無いときにスキーマにない articleHtml が返ったら、捨てて警告を出す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(geminiOk());

    const result = await generateSummary(
      "test-key",
      1,
      "Title",
      "https://example.com/post",
      { status: "fetch_skipped" },
      ["[alice]: comment"],
    );

    expect(result.doc.article).toEqual({ status: "fetch_skipped" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(
      "ignored articleHtml outside the response schema: item=1 article=fetch_skipped",
    );
  });

  it("許可外の属性を持つリンクは、照合で外す前の検証で SummaryFormatError にする", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      geminiOk({
        text: JSON.stringify({
          ...VALID_DOC,
          articleHtml: '<p><a href="https://evil.test/" onclick="x">x</a></p>',
        }),
      }),
    );

    await expect(summarize()).rejects.toThrow(SummaryFormatError);
  });
});

describe("parseSummaryResponse", () => {
  const parse = async (o: unknown) =>
    (await parseSummaryResponse(JSON.stringify(o), "ok")).doc;

  it("正常なJSONを要約文書に変換する", async () => {
    expect(await parse(VALID_DOC)).toEqual({
      jaTitle: VALID_DOC.jaTitle,
      article: { status: "ok", html: VALID_DOC.articleHtml },
      hnOverviewHtml: VALID_DOC.hnOverviewHtml,
      topics: VALID_DOC.topics,
    });
  });

  it("topics が空でも通す", async () => {
    expect((await parse({ ...VALID_DOC, topics: [] })).topics).toEqual([]);
  });

  it("不正なJSONを拒否する", async () => {
    await expect(parseSummaryResponse("{", "ok")).rejects.toThrow(
      SummaryFormatError,
    );
  });

  it("配列やnullを拒否する", async () => {
    await expect(parseSummaryResponse("null", "ok")).rejects.toThrow(
      SummaryFormatError,
    );
    await expect(parseSummaryResponse("[]", "ok")).rejects.toThrow(
      SummaryFormatError,
    );
  });

  it("フィールド欠落を拒否する", async () => {
    await expect(parse({ jaTitle: "x", topics: [] })).rejects.toThrow(
      SummaryFormatError,
    );
  });

  it("本文があるのに articleHtml が無ければ拒否する", async () => {
    await expect(
      parse({ ...VALID_DOC, articleHtml: undefined }),
    ).rejects.toThrow(SummaryFormatError);
  });

  it("本文が無いときは articleHtml を読まず、理由だけを持たせる", async () => {
    const result = await parseSummaryResponse(
      JSON.stringify({ ...VALID_DOC, articleHtml: undefined }),
      "fetch_skipped",
    );
    expect(result).toMatchObject({
      doc: { article: { status: "fetch_skipped" } },
      ignoredArticleHtml: false,
    });
  });

  it.each([123, " ", "<script>x</script>"])(
    "本文が無いときにスキーマにない articleHtml（%j）が返ったら、検証せずに捨てたことを返す",
    async (articleHtml) => {
      const result = await parseSummaryResponse(
        JSON.stringify({ ...VALID_DOC, articleHtml }),
        "fetch_skipped",
      );
      expect(result).toMatchObject({
        doc: { article: { status: "fetch_skipped" } },
        ignoredArticleHtml: true,
      });
    },
  );

  it("HTML 断片に許可外の属性があれば拒否する", async () => {
    await expect(
      parse({
        ...VALID_DOC,
        hnOverviewHtml:
          '<p><a href="https://example.com/" onclick="x">x</a></p>',
      }),
    ).rejects.toThrow(SummaryFormatError);
  });

  it("空の articleHtml は拒否する", async () => {
    await expect(parse({ ...VALID_DOC, articleHtml: " " })).rejects.toThrow(
      SummaryFormatError,
    );
  });

  it("topics が配列でない場合を拒否する", async () => {
    await expect(parse({ ...VALID_DOC, topics: "not array" })).rejects.toThrow(
      SummaryFormatError,
    );
  });

  it("空の jaTitle を拒否する", async () => {
    await expect(parse({ ...VALID_DOC, jaTitle: " " })).rejects.toThrow(
      SummaryFormatError,
    );
  });

  it("空の topic heading を拒否する", async () => {
    await expect(
      parse({ ...VALID_DOC, topics: [{ heading: "", bodyHtml: "<p>x</p>" }] }),
    ).rejects.toThrow(SummaryFormatError);
  });

  it.each([
    ["空文字", ""],
    ["空白だけ", "  \n\t "],
  ])("観点の本文（bodyHtml）が%sなら拒否する", async (_label, bodyHtml) => {
    await expect(
      parse({ ...VALID_DOC, topics: [{ heading: "観点1", bodyHtml }] }),
    ).rejects.toThrow(SummaryFormatError);
  });
});
