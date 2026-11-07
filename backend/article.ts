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
  | { status: "ok"; content: string; method: "raw" | "firecrawl" | "wayback" }
  | { status: "fetch_failed" }
  | { status: "fetch_skipped" }
  | { status: "no_url" };

// HTMLRewriter は DOM を実体化せずに要素を落とせるので、ネストで
// 壊れる正規表現より構造的に正しい。body の main は残す。
// 確度の高い対象だけ落とす。div/section の class/id 判定は本文を
// 巻き添えで消す可能性があるため行わない。
async function readableTextFromResponse(resp: Response): Promise<string> {
  const cleanedHtml = await new HTMLRewriter()
    .on("script, style, noscript, svg, template, header, nav, footer, aside", {
      element(el) {
        el.remove();
      },
    })
    .on(
      "[role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary']",
      {
        element(el) {
          el.remove();
        },
      },
    )
    .transform(resp)
    .text();
  return stripHtml(cleanedHtml);
}

async function extractReadableText(resp: Response): Promise<string | null> {
  const contentType = resp.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html");
  const isPlain = contentType.includes("text/plain");
  if (!isHtml && !isPlain) return null;
  const text = isHtml
    ? await readableTextFromResponse(resp)
    : stripHtml(await resp.text());
  return clampContent(text);
}

async function fetchRaw(url: string, host: string): Promise<string | null> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; HNSummaryBot/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    console.warn(`  [article] raw fetch returned ${resp.status} for ${host}`);
    return null;
  }
  const extracted = await extractReadableText(resp);
  if (!extracted) {
    console.warn(
      `  [article] raw fetch returned no usable content for ${host}`,
    );
  }
  return extracted;
}

async function fetchViaFirecrawl(
  url: string,
  host: string,
  apiKey?: string,
): Promise<string | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const resp = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers,
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      proxy: "auto",
      timeout: 30_000,
      maxAge: 0,
    }),
    signal: AbortSignal.timeout(35_000),
  });
  if (!resp.ok) {
    console.warn(`  [article] firecrawl returned ${resp.status} for ${host}`);
    return null;
  }
  const payload = (await resp.json().catch(() => null)) as {
    success?: boolean;
    data?: {
      markdown?: string;
      metadata?: { statusCode?: number };
    };
    error?: string;
  } | null;
  if (!payload?.success) {
    console.warn(
      `  [article] firecrawl returned no success for ${host}: ${payload?.error ?? "unknown"}`,
    );
    return null;
  }
  const statusCode = payload.data?.metadata?.statusCode;
  if (
    statusCode !== undefined &&
    statusCode !== 200 &&
    statusCode !== 304 &&
    (statusCode < 200 || statusCode >= 300)
  ) {
    console.warn(`  [article] firecrawl page status ${statusCode} for ${host}`);
    return null;
  }
  const markdown = (payload.data?.markdown ?? "").trim();
  if (!markdown) {
    console.warn(
      `  [article] firecrawl returned no usable content for ${host}`,
    );
    return null;
  }
  return clampContent(markdown);
}

function waybackIdUrl(snapshotUrl: string): string | null {
  try {
    const parsed = new URL(snapshotUrl);
    // /web/<timestamp+任意の修飾子>/<残り>。修飾子（im_ 等）は捨てて正規化する
    const match = parsed.pathname.match(/^\/web\/([^/]+)\/(.*)$/);
    if (!match) return null;
    const digits = match[1].match(/^(\d+)/)?.[1];
    if (!digits) return null;
    parsed.pathname = `/web/${digits}id_/${match[2]}`;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function fetchViaWayback(
  url: string,
  host: string,
): Promise<string | null> {
  const availableUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const availableResp = await fetch(availableUrl, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!availableResp.ok) {
    console.warn(
      `  [article] wayback available returned ${availableResp.status} for ${host}`,
    );
    return null;
  }
  const payload = (await availableResp.json().catch(() => null)) as {
    archived_snapshots?: {
      closest?: { available?: boolean; url?: string; timestamp?: string };
    };
  } | null;
  const closest = payload?.archived_snapshots?.closest;
  if (!closest?.available || (!closest.url && !closest.timestamp)) {
    console.log(`  [article] wayback has no snapshot for ${host}`);
    return null;
  }
  const snapshotUrl = closest.timestamp
    ? `https://web.archive.org/web/${closest.timestamp}id_/${url}`
    : closest.url
      ? waybackIdUrl(closest.url)
      : null;
  if (!snapshotUrl) return null;
  const resp = await fetch(snapshotUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; HNSummaryBot/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    console.warn(
      `  [article] wayback fetch returned ${resp.status} for ${host}`,
    );
    return null;
  }
  const extracted = await extractReadableText(resp);
  if (!extracted) {
    console.warn(
      `  [article] wayback fetch returned no usable content for ${host}`,
    );
  }
  return extracted;
}

// Paywall などでまともなコンテンツが取れないのにトークン消費だけするものは弾く
// YouTube は記事本文がなく、取得しても殻（183 文字前後）しか得られないため対象外
const SKIPPED_HOSTS = [
  "www.bloomberg.com",
  "bloomberg.com",
  "www.nytimes.com",
  "nytimes.com",
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
];

export async function fetchArticleContent(
  url: string,
  firecrawlApiKey?: string,
): Promise<ArticleResult> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (err) {
    console.error(`  [article] invalid url: ${url}`, err);
    return { status: "fetch_failed" };
  }
  if (SKIPPED_HOSTS.includes(host)) {
    console.log(`  [article] skipping ${host} (skip list)`);
    return { status: "fetch_skipped" };
  }

  try {
    const content = await fetchRaw(url, host);
    if (content) {
      console.log(
        `  [article] fetched via raw fetch (${content.length} chars)`,
      );
      return { status: "ok", content, method: "raw" };
    }
    console.log(
      "  [article] raw fetch returned no usable content, trying firecrawl",
    );
  } catch (err) {
    console.warn(`  [article] raw fetch failed: ${err}`);
  }

  try {
    const content = await fetchViaFirecrawl(url, host, firecrawlApiKey);
    if (content) {
      console.log(
        `  [article] fetched via firecrawl (${content.length} chars)`,
      );
      return { status: "ok", content, method: "firecrawl" };
    }
    console.log(
      "  [article] firecrawl returned no usable content, trying wayback",
    );
  } catch (err) {
    console.warn(`  [article] firecrawl failed (${err}), trying wayback`);
  }

  try {
    const content = await fetchViaWayback(url, host);
    if (content) {
      console.log(`  [article] fetched via wayback (${content.length} chars)`);
      return { status: "ok", content, method: "wayback" };
    }
  } catch (err) {
    console.warn(`  [article] wayback failed: ${err}`);
  }

  return { status: "fetch_failed" };
}
