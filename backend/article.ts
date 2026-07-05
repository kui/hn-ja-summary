import { stripHtml } from "@hn-feed/shared/html";

const MAX_CONTENT_LENGTH = 15_000;
const MIN_CONTENT_LENGTH = 100;

function clampContent(text: string): string | null {
  if (text.length < MIN_CONTENT_LENGTH) return null;
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  return `${text.slice(0, MAX_CONTENT_LENGTH)}\n（本文はここで切り詰められている。以降の内容を推測で補完しないこと）`;
}

// generateSummary に渡す型（method 不要）
export type ArticleInput =
  | { status: "ok"; content: string }
  | { status: "fetch_failed" }
  | { status: "fetch_skipped" }
  | { status: "no_url" };

// fetchArticleContent の戻り値（取得方法を含む）
export type ArticleResult =
  | { status: "ok"; content: string; method: "jina" | "raw" }
  | { status: "fetch_failed" }
  | { status: "fetch_skipped" }
  | { status: "no_url" };

function stripHtmlWithInlineScripts(html: string): string {
  return stripHtml(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ""),
  );
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
  return clampContent((await resp.text()).trim());
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
  return clampContent(stripHtmlWithInlineScripts(await resp.text()));
}

// Paywall などでまともなコンテンツが取れないのにトークン消費だけするものは弾く
const SKIPPED_HOSTS = [
  "www.bloomberg.com",
  "bloomberg.com",
  "www.nytimes.com",
  "nytimes.com",
];

export async function fetchArticleContent(
  url: string,
  jinaApiKey?: string,
): Promise<ArticleResult> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (err) {
    console.error(`  [article] invalid url: ${url}`, err);
    return { status: "fetch_failed" };
  }
  if (SKIPPED_HOSTS.includes(host)) {
    console.log(`  [article] skipping ${host} (known paywall)`);
    return { status: "fetch_skipped" };
  }

  try {
    const content = await fetchViaJina(url, jinaApiKey);
    if (content) {
      console.log(`  [article] fetched via Jina (${content.length} chars)`);
      return { status: "ok", content, method: "jina" };
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
      return { status: "ok", content, method: "raw" };
    }
    console.log("  [article] raw fetch returned no usable content");
  } catch (err) {
    console.warn(`  [article] raw fetch failed: ${err}`);
  }

  return { status: "fetch_failed" };
}
