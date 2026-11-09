import { afterEach, describe, expect, it, vi } from "vitest";
import { Temporal } from "temporal-polyfill";
import { fetchArticleContent } from "./article.ts";

const API_KEY = "fc-key";
const POSTED_AT = Temporal.Instant.from(
  "2024-01-02T00:00:00Z",
).epochMilliseconds;
const BODY = "本文です。".repeat(50);

function htmlResponse(
  body: string,
  status = 200,
  contentType = "text/html; charset=utf-8",
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

// TextEncoder は UTF-8 しか出力できないため、非 UTF-8 の本文はバイト列で用意する。
// "本文です。" の Shift_JIS / EUC-JP エンコード。
const SJIS_BUNSHOU = new Uint8Array([
  150, 123, 149, 182, 130, 197, 130, 183, 129, 66,
]);
const EUCJP_BUNSHOU = new Uint8Array([
  203, 220, 202, 184, 164, 199, 164, 185, 161, 163,
]);

function repeatBytes(bytes: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(bytes.length * count);
  for (let i = 0; i < count; i++) out.set(bytes, i * bytes.length);
  return out;
}

function bytesResponse(parts: Uint8Array[], contentType: string): Response {
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return new Response(body, { headers: { "content-type": contentType } });
}

function encodedHtmlResponse(
  encodedText: Uint8Array,
  contentType: string,
  head = "",
): Response {
  const encoder = new TextEncoder();
  return bytesResponse(
    [
      encoder.encode(`<html><head>${head}</head><body><main>`),
      repeatBytes(encodedText, 50),
      encoder.encode("</main></body></html>"),
    ],
    contentType,
  );
}

function firecrawlOk(statusCode = 200): Response {
  return Response.json({
    success: true,
    data: { markdown: BODY, metadata: { statusCode } },
  });
}

function waybackAvailable(timestamp: string): Response {
  return Response.json({
    archived_snapshots: {
      closest: {
        status: "200",
        available: true,
        url: `http://web.archive.org/web/${timestamp}/https://example.com/post`,
        timestamp,
      },
    },
  });
}

type Handler = (url: string, init?: RequestInit) => Response;

function mockFetch(handler: Handler) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => handler(String(input), init));
}

function fetchArticle(url = "https://example.com/post") {
  return fetchArticleContent(url, API_KEY, POSTED_AT);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchArticleContent", () => {
  it("raw で header/nav/footer、role 付きの枠、script を除去して本文を返す", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(
          `<html><head><title>Example</title></head><body><header>site header</header><nav>site nav</nav><div role="banner">role banner</div><div role="navigation">role nav</div><main>${BODY}</main><div role="complementary">role side</div><div role="contentinfo">role info</div><footer>site footer</footer><script>evil()</script></body></html>`,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.method).toBe("raw");
    expect(result.content).toContain("本文です。");
    for (const removed of [
      "site header",
      "site nav",
      "site footer",
      "role banner",
      "role nav",
      "role side",
      "role info",
      "evil()",
    ]) {
      expect(result.content).not.toContain(removed);
    }
  });

  it("raw は article の中の header/footer/aside を本文として残す", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(
          `<html><body><header>site header</header><main><article><header>byline</header><article><aside>inner note</aside></article>${BODY}<aside>side note</aside><footer>footnote</footer></article></main><aside>site aside</aside><footer>site footer</footer></body></html>`,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    for (const kept of ["byline", "inner note", "side note", "footnote"]) {
      expect(result.content).toContain(kept);
    }
    for (const removed of ["site header", "site aside", "site footer"]) {
      expect(result.content).not.toContain(removed);
    }
  });

  it("raw は閉じタグのない article の後ろにあるページの footer を削除する", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(
          `<html><body><main><article><header>byline</header><p>${BODY}</main><footer>site footer</footer></body></html>`,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.content).toContain("byline");
    expect(result.content).not.toContain("site footer");
  });

  it("最上位の article が 1 つで本文の大半を占めるなら、その中だけを返す", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(
          `<html><body><div>premium promo</div><article><h1>headline</h1>${BODY}</article><div>related links</div></body></html>`,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status === "ok" && result.content).toBe(`headline ${BODY}`);
  });

  it("article が本文ではない小さなカードだけなら、ページ全体から枠を除いたものを返す", async () => {
    const card = "おすすめ記事".repeat(20);
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(
          `<html><body><main>${BODY}<article>${card}</article></main></body></html>`,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status === "ok" && result.content).toBe(`${BODY} ${card}`);
  });

  it.each([
    { length: 99, expected: (a: string) => `i ${a}` },
    { length: 100, expected: (a: string) => a },
  ])(
    "article の中が 100 文字未満ならページ全体を返す（$length 文字）",
    async ({ length, expected }) => {
      const article = "a".repeat(length);
      mockFetch((url) => {
        if (url.startsWith("https://example.com/")) {
          return htmlResponse(
            `<html><body><div>i</div><article>${article}</article></body></html>`,
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const result = await fetchArticle();

      expect(result.status === "ok" && result.content).toBe(expected(article));
    },
  );

  // ページは「intro + 区切りの空白 + BODY」なので、intro が BODY より 1 文字短いとちょうど 50%
  it.each([
    { introLength: BODY.length - 1, usesArticle: true },
    { introLength: BODY.length, usesArticle: false },
  ])(
    "article がページのちょうど半分なら使い、半分に満たなければページ全体を返す（intro $introLength 文字）",
    async ({ introLength, usesArticle }) => {
      const intro = "x".repeat(introLength);
      mockFetch((url) => {
        if (url.startsWith("https://example.com/")) {
          return htmlResponse(
            `<html><body><div>${intro}</div><article>${BODY}</article></body></html>`,
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const result = await fetchArticle();

      expect(result.status === "ok" && result.content).toBe(
        usesArticle ? BODY : `${intro} ${BODY}`,
      );
    },
  );

  it("最上位の article が 2 つ以上なら、ページ全体から枠を除いたものを返す", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(
          `<html><body><div>page intro</div><article>${BODY}</article><article>next post</article></body></html>`,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status === "ok" && result.content).toBe(
      `page intro ${BODY} next post`,
    );
  });

  it("コメントが入れ子の article でも、最上位の article の中をコメントごと返す", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(
          `<html><body><div>blog promo</div><article>${BODY}<section><article>comment one</article><article>comment two</article></section></article><div>blogroll</div></body></html>`,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status === "ok" && result.content).toBe(
      `${BODY} comment one comment two`,
    );
  });

  it("削除される枠の中の article は数えない", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(
          `<html><body><div>page intro</div><header><article>header card</article></header><nav><article>nav card</article></nav><footer><article>footer card</article></footer><aside><article>side card</article></aside><article role="complementary">role card</article><article>${BODY}</article></body></html>`,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status === "ok" && result.content).toBe(BODY);
  });

  it("</article> が無くても親の終了タグで閉じれば、article の中だけを返す", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(
          `<html><body><div>page intro</div><main><article>${BODY}</main></body></html>`,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status === "ok" && result.content).toBe(BODY);
  });

  it("文書が途中で切れて article が閉じないなら、ページ全体を返す", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(
          `<html><body><div>page intro</div><article>${BODY}`,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status === "ok" && result.content).toBe(`page intro ${BODY}`);
  });

  it("raw は application/xhtml+xml も本文として読む", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(
          `<html><body><main>${BODY}</main></body></html>`,
          200,
          "application/xhtml+xml",
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status === "ok" && result.method).toBe("raw");
  });

  it("raw は text/plain をそのまま本文として読む", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(BODY, 200, "text/plain; charset=utf-8");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status === "ok" && result.content).toBe(BODY);
  });

  it.each([
    { name: "Shift_JIS", charset: "Shift_JIS", encoded: SJIS_BUNSHOU },
    { name: "EUC-JP", charset: "EUC-JP", encoded: EUCJP_BUNSHOU },
  ])(
    "raw は $name でエンコードされた本文を正しくデコードする",
    async ({ charset, encoded }) => {
      mockFetch((url) => {
        if (url.startsWith("https://example.com/")) {
          return encodedHtmlResponse(encoded, `text/html; charset=${charset}`);
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const result = await fetchArticle();

      expect(result.status === "ok" && result.method).toBe("raw");
      expect(result.status === "ok" && result.content).toBe(BODY);
    },
  );

  it("raw は Content-Type に charset がなければ <meta charset> から文字コードを決める", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return encodedHtmlResponse(
          SJIS_BUNSHOU,
          "text/html",
          '<meta charset="Shift_JIS">',
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status === "ok" && result.method).toBe("raw");
    expect(result.status === "ok" && result.content).toBe(BODY);
  });

  it("raw は知らない charset ラベルを UTF-8 として読む", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(BODY, 200, "text/html; charset=Unknown-Charset");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status === "ok" && result.method).toBe("raw");
    expect(result.status === "ok" && result.content).toBe(BODY);
  });

  it("長い本文は切り詰めて、その旨を書き添える", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse("あ".repeat(20_000), 200, "text/plain");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.content.startsWith("あ".repeat(15_000))).toBe(true);
    expect(result.content).not.toContain("あ".repeat(15_001));
    expect(result.content).toContain("本文はここで切り詰められている");
  });

  it("raw が非 2xx なら status と host を warn に出し、キー付きで firecrawl を呼ぶ", async () => {
    let authorization: string | null = null;
    mockFetch((url, init) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse("not found", 404);
      }
      if (url.startsWith("https://api.firecrawl.dev/")) {
        authorization = new Headers(init?.headers).get("Authorization");
        return firecrawlOk();
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchArticle();

    expect(result.status === "ok" && result.method).toBe("firecrawl");
    expect(authorization).toBe(`Bearer ${API_KEY}`);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("raw fetch returned 404 for example.com"),
    );
  });

  it("firecrawl が success でも元ページが 2xx 以外なら使わない", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse("blocked", 403);
      }
      if (url.startsWith("https://api.firecrawl.dev/")) {
        return firecrawlOk(403);
      }
      if (url.startsWith("https://archive.org/wayback/available")) {
        return Response.json({ archived_snapshots: {} });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchArticle();

    expect(result.status).toBe("fetch_failed");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("firecrawl page status 403 for example.com"),
    );
  });

  it("firecrawl の非 2xx は本文の error もログに出す", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse("blocked", 403);
      }
      if (url.startsWith("https://api.firecrawl.dev/")) {
        return Response.json(
          { success: false, error: "Insufficient credits" },
          { status: 402 },
        );
      }
      if (url.startsWith("https://archive.org/wayback/available")) {
        return Response.json({ archived_snapshots: {} });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await fetchArticle();

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /firecrawl returned 402 for example\.com: .*Insufficient credits/,
      ),
    );
  });

  it("raw と firecrawl が落ちたら、投稿日時に近い wayback のスナップショットを使う", async () => {
    const requested: string[] = [];
    mockFetch((url) => {
      requested.push(url);
      if (url.startsWith("https://example.com/")) {
        return htmlResponse("blocked", 403);
      }
      if (url.startsWith("https://api.firecrawl.dev/")) {
        return htmlResponse("rate limited", 429);
      }
      if (url.startsWith("https://archive.org/wayback/available")) {
        return waybackAvailable("20240101120000");
      }
      if (
        url ===
        "https://web.archive.org/web/20240101120000id_/https://example.com/post"
      ) {
        return htmlResponse(`<html><body><main>${BODY}</main></body></html>`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status === "ok" && result.method).toBe("wayback");
    expect(
      requested.find((u) => u.startsWith("https://archive.org/")),
    ).toContain("timestamp=20240102000000");
  });

  it("wayback のスナップショットが投稿日時から離れすぎていたら使わない", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse("blocked", 403);
      }
      if (url.startsWith("https://api.firecrawl.dev/")) {
        return htmlResponse("rate limited", 429);
      }
      if (url.startsWith("https://archive.org/wayback/available")) {
        return waybackAvailable("20190101000000");
      }
      if (url.startsWith("https://web.archive.org/web/20190101000000id_/")) {
        return htmlResponse(`<html><body><main>${BODY}</main></body></html>`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle();

    expect(result.status).toBe("fetch_failed");
  });

  it("すべての手段が落ちたら fetch_failed を返す", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://archive.org/wayback/available")) {
        return Response.json({ archived_snapshots: {} });
      }
      if (url.startsWith("https://api.firecrawl.dev/")) {
        return htmlResponse("no", 429);
      }
      return htmlResponse("no", 500);
    });

    const result = await fetchArticle();

    expect(result.status).toBe("fetch_failed");
  });

  it.each([
    "https://www.nytimes.com/post",
    "https://cooking.nytimes.com/recipe",
    "https://www.bloomberg.com/news",
  ])("既知のペイウォール %s は fetch_skipped を返す", async (url) => {
    const result = await fetchArticle(url);

    expect(result.status).toBe("fetch_skipped");
  });

  it.each([
    "https://www.youtube.com/watch?v=UufMqwyO7pY",
    "https://m.youtube.com/watch?v=UufMqwyO7pY",
    "https://music.youtube.com/watch?v=UufMqwyO7pY",
    "https://youtu.be/UufMqwyO7pY",
    "https://www.youtube-nocookie.com/embed/UufMqwyO7pY",
  ])("YouTube の %s は本文が取れないので fetch_skipped を返す", async (url) => {
    const result = await fetchArticle(url);

    expect(result.status).toBe("fetch_skipped");
  });

  it("末尾が一致するだけの別ドメインは skip しない", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://notyoutube.com/")) {
        return htmlResponse(`<html><body><main>${BODY}</main></body></html>`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticle("https://notyoutube.com/post");

    expect(result.status).toBe("ok");
  });

  it("不正な URL は fetch_failed を返す", async () => {
    const result = await fetchArticle("not a url");

    expect(result.status).toBe("fetch_failed");
  });
});
