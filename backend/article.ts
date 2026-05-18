const MAX_CONTENT_LENGTH = 15_000;
const MIN_CONTENT_LENGTH = 100;

export type ArticleResult =
  | { status: "ok"; content: string }
  | { status: "fetch_failed" }
  | { status: "no_url" };

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchViaJina(
  url: string,
  apiKey?: string,
): Promise<string | null> {
  const headers: Record<string, string> = { Accept: "text/plain" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const resp = await fetch(`https://r.jina.ai/${url}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) return null;
  const contentType = resp.headers.get("content-type") ?? "";
  if (
    !contentType.includes("text/plain") &&
    !contentType.includes("text/markdown")
  ) {
    return null;
  }
  const text = (await resp.text()).trim();
  return text.length >= MIN_CONTENT_LENGTH
    ? text.slice(0, MAX_CONTENT_LENGTH)
    : null;
}

async function fetchRaw(url: string): Promise<string | null> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; HNSummaryBot/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;
  const contentType = resp.headers.get("content-type") ?? "";
  if (
    !contentType.includes("text/html") &&
    !contentType.includes("text/plain")
  ) {
    return null;
  }
  const text = stripHtml(await resp.text());
  return text.length >= MIN_CONTENT_LENGTH
    ? text.slice(0, MAX_CONTENT_LENGTH)
    : null;
}

export async function fetchArticleContent(
  url: string,
  jinaApiKey?: string,
): Promise<ArticleResult> {
  try {
    const content = await fetchViaJina(url, jinaApiKey);
    if (content) {
      console.log(`  [article] fetched via Jina (${content.length} chars)`);
      return { status: "ok", content };
    }
    console.log(
      "  [article] Jina returned no usable content, trying raw fetch",
    );
  } catch (err) {
    console.warn(`  [article] Jina failed (${err}), trying raw fetch`);
  }

  try {
    const content = await fetchRaw(url);
    if (content) {
      console.log(
        `  [article] fetched via raw fetch (${content.length} chars)`,
      );
      return { status: "ok", content };
    }
    console.log("  [article] raw fetch returned no usable content");
  } catch (err) {
    console.warn(`  [article] raw fetch failed: ${err}`);
  }

  return { status: "fetch_failed" };
}
