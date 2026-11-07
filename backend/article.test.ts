import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchArticleContent } from "./article.ts";

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function mockFetch(handler: (url: string) => Response) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => handler(String(input)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchArticleContent", () => {
  it("raw で header/nav/footer と script を除去して本文を返す", async () => {
    const bodyText = "本文です。".repeat(50);
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse(
          `<html><head><title>Example</title></head><body><header>site header</header><nav>site nav</nav><main>${bodyText}</main><footer>site footer</footer><script>evil()</script></body></html>`,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticleContent("https://example.com/post");

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.method).toBe("raw");
    expect(result.content).toContain("本文です。");
    expect(result.content).not.toContain("site header");
    expect(result.content).not.toContain("site nav");
    expect(result.content).not.toContain("site footer");
  });

  it("raw が非 2xx なら status と host を warn に出す", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse("not found", 404);
      }
      if (url.startsWith("https://api.firecrawl.dev/")) {
        return Response.json(
          {
            success: true,
            data: {
              markdown: "本文です。".repeat(50),
              metadata: { statusCode: 200 },
            },
          },
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchArticleContent(
      "https://example.com/post",
      "fc-key",
    );

    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.method).toBe("firecrawl");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("raw fetch returned 404 for example.com"),
    );
  });

  it("raw と firecrawl が落ちたら wayback を使う", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://example.com/")) {
        return htmlResponse("blocked", 403);
      }
      if (url.startsWith("https://api.firecrawl.dev/")) {
        return Response.json(
          { success: false, error: "Payment required" },
          { status: 402 },
        );
      }
      if (url.startsWith("https://archive.org/wayback/available")) {
        return Response.json({
          archived_snapshots: {
            closest: {
              available: true,
              url: "https://web.archive.org/web/20240101120000/https://example.com/post",
            },
          },
        });
      }
      if (url.startsWith("https://web.archive.org/web/20240101120000id_/")) {
        return htmlResponse(
          `<html><body><main>${"本文です。".repeat(50)}</main></body></html>`,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchArticleContent("https://example.com/post");

    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.method).toBe("wayback");
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

    const result = await fetchArticleContent("https://example.com/post");

    expect(result.status).toBe("fetch_failed");
  });

  it("既知のペイウォールは fetch_skipped を返す", async () => {
    const result = await fetchArticleContent("https://www.nytimes.com/post");

    expect(result.status).toBe("fetch_skipped");
  });

  it("YouTube は本文が取れないので fetch_skipped を返す", async () => {
    const result = await fetchArticleContent(
      "https://www.youtube.com/watch?v=UufMqwyO7pY",
    );

    expect(result.status).toBe("fetch_skipped");
  });

  it("不正な URL は fetch_failed を返す", async () => {
    const result = await fetchArticleContent("not a url");

    expect(result.status).toBe("fetch_failed");
  });
});
