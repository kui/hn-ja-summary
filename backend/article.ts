import { Temporal } from "temporal-polyfill";
import { stripHtml } from "@hn-feed/shared/html";

const MAX_CONTENT_LENGTH = 15_000;
const MIN_CONTENT_LENGTH = 100;
// HN の投稿日時からこれ以上離れたスナップショットは、同じ URL でも別の内容の可能性が高い
const WAYBACK_MAX_DRIFT_MS = 30 * 24 * 60 * 60 * 1000;
const USER_AGENT = "Mozilla/5.0 (compatible; HNSummaryBot/1.0)";

function clampContent(text: string): string | null {
  if (text.length < MIN_CONTENT_LENGTH) return null;
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  return `${text.slice(0, MAX_CONTENT_LENGTH)}\n（本文はここで切り詰められている。以降の内容を推測で補完しないこと）`;
}

// 読まない本文を残すと、GC されるまで Workers の同時接続数に数えられる
async function discardBody(resp: Response): Promise<void> {
  await resp.body?.cancel();
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
async function readableParts(
  resp: Response,
): Promise<{ page: string; articles: string[] }> {
  // 最上位の article の範囲を、出力に残したコメントで後から切り出す。
  // 印はページ側に同じ文字列がありえないよう呼び出しごとに変える。
  // 中に入れるので、article が枠と一緒に消されれば印も消え、数に入らない
  const nonce = crypto.randomUUID();
  const startMark = `<!--article-start-${nonce}-->`;
  const endMark = `<!--article-end-${nonce}-->`;
  // article の中の header/footer/aside は著者・日付・脚注・補足といった
  // 本文の一部なので残す。HTMLRewriter の :not() は子孫結合子を書くと
  // 何にも一致しないため、開始・終了タグで article の深さを数えて判定する
  let articleDepth = 0;
  const cleanedHtml = await new HTMLRewriter()
    .on("article", {
      element(el) {
        if (articleDepth === 0) {
          el.prepend(startMark, { html: true });
          el.append(endMark, { html: true });
        }
        articleDepth++;
        el.onEndTag(() => {
          articleDepth--;
        });
      },
    })
    .on("script, style, noscript, svg, template, nav", {
      element(el) {
        el.remove();
      },
    })
    .on("header, footer, aside", {
      element(el) {
        if (articleDepth === 0) el.remove();
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
  const segments = cleanedHtml.split(startMark).slice(1);
  const ends = segments.map((rest) => rest.indexOf(endMark));
  return {
    page: stripHtml(cleanedHtml),
    // 閉じていない article があると範囲がわからないので、article は使わない
    articles: ends.includes(-1)
      ? []
      : segments.map((rest, i) => stripHtml(rest.slice(0, ends[i]))),
  };
}

// article がおすすめ記事のカードや本文の一部にしか使われていないページでは、
// article だけを読むと本文が消えるため、ページの文字数の半分以上を占めるときだけ使う
const ARTICLE_MIN_SHARE = 0.5;

async function readableTextFromResponse(resp: Response): Promise<string> {
  const { page, articles } = await readableParts(resp);
  const [article] = articles;
  if (
    articles.length === 1 &&
    article.length >= MIN_CONTENT_LENGTH &&
    article.length >= page.length * ARTICLE_MIN_SHARE
  ) {
    return article;
  }
  return page;
}

async function extractReadableText(resp: Response): Promise<string | null> {
  const contentType = resp.headers.get("content-type") ?? "";
  const isHtml =
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml+xml");
  const isPlain = contentType.includes("text/plain");
  if (!isHtml && !isPlain) {
    await discardBody(resp);
    return null;
  }
  const text = isHtml
    ? await readableTextFromResponse(resp)
    : stripHtml(await resp.text());
  return clampContent(text);
}

// raw と Wayback のスナップショットは、どちらも元ページの HTML をそのまま読む
async function fetchPage(
  url: string,
  label: string,
  host: string,
): Promise<string | null> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    await discardBody(resp);
    console.warn(`  [article] ${label} returned ${resp.status} for ${host}`);
    return null;
  }
  const extracted = await extractReadableText(resp);
  if (!extracted) {
    console.warn(`  [article] ${label} returned no usable content for ${host}`);
  }
  return extracted;
}

async function fetchViaFirecrawl(
  url: string,
  host: string,
  apiKey: string,
): Promise<string | null> {
  const resp = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      proxy: "auto",
      timeout: 30_000,
    }),
    signal: AbortSignal.timeout(35_000),
  });
  if (!resp.ok) {
    // 402（クレジット切れ）と 429（レート制限）は本文の error でしか見分けられない
    const detail = (await resp.text().catch(() => "")).slice(0, 200);
    console.warn(
      `  [article] firecrawl returned ${resp.status} for ${host}: ${detail}`,
    );
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
  if (statusCode !== undefined && (statusCode < 200 || statusCode >= 300)) {
    console.warn(`  [article] firecrawl page status ${statusCode} for ${host}`);
    return null;
  }
  const markdown = (payload.data?.markdown ?? "").trim();
  const content = clampContent(markdown);
  if (!content) {
    console.warn(
      `  [article] firecrawl returned no usable content for ${host}`,
    );
  }
  return content;
}

// Wayback の timestamp は UTC の YYYYMMDDhhmmss
function toWaybackTimestamp(epochMs: number): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toString({ smallestUnit: "second" })
    .replace(/\D/g, "");
}

function fromWaybackTimestamp(timestamp: string): number | null {
  const m = timestamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  return Temporal.Instant.from(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`,
  ).epochMilliseconds;
}

async function fetchViaWayback(
  url: string,
  host: string,
  postedAtMs: number,
): Promise<string | null> {
  const availableUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=${toWaybackTimestamp(postedAtMs)}`;
  const availableResp = await fetch(availableUrl, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!availableResp.ok) {
    await discardBody(availableResp);
    console.warn(
      `  [article] wayback available returned ${availableResp.status} for ${host}`,
    );
    return null;
  }
  const payload = (await availableResp.json().catch(() => null)) as {
    archived_snapshots?: {
      closest?: { available?: boolean; timestamp?: string };
    };
  } | null;
  const closest = payload?.archived_snapshots?.closest;
  const timestamp = closest?.available ? closest.timestamp : undefined;
  const snapshotMs = timestamp ? fromWaybackTimestamp(timestamp) : null;
  if (!timestamp || snapshotMs === null) {
    console.log(`  [article] wayback has no snapshot for ${host}`);
    return null;
  }
  if (Math.abs(snapshotMs - postedAtMs) > WAYBACK_MAX_DRIFT_MS) {
    console.log(
      `  [article] wayback snapshot ${timestamp} is too far from the post for ${host}`,
    );
    return null;
  }
  return fetchPage(
    `https://web.archive.org/web/${timestamp}id_/${url}`,
    "wayback fetch",
    host,
  );
}

// Paywall などでまともなコンテンツが取れないのにトークン消費だけするものは弾く
// YouTube は記事本文がなく、取得しても殻（183 文字前後）しか得られないため対象外
// サブドメイン（m.youtube.com、cooking.nytimes.com など）も同じ扱いにする
const SKIPPED_DOMAINS = [
  "bloomberg.com",
  "nytimes.com",
  "youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
];

function isSkippedHost(host: string): boolean {
  return SKIPPED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export async function fetchArticleContent(
  url: string,
  firecrawlApiKey: string,
  postedAtMs: number,
): Promise<ArticleResult> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (err) {
    console.error(`  [article] invalid url: ${url}`, err);
    return { status: "fetch_failed" };
  }
  if (isSkippedHost(host)) {
    console.log(`  [article] skipping ${host} (skip list)`);
    return { status: "fetch_skipped" };
  }

  try {
    const content = await fetchPage(url, "raw fetch", host);
    if (content) {
      console.log(
        `  [article] fetched via raw fetch (${content.length} chars)`,
      );
      return { status: "ok", content, method: "raw" };
    }
  } catch (err) {
    console.warn(`  [article] raw fetch failed for ${host}: ${err}`);
  }

  try {
    const content = await fetchViaFirecrawl(url, host, firecrawlApiKey);
    if (content) {
      console.log(
        `  [article] fetched via firecrawl (${content.length} chars)`,
      );
      return { status: "ok", content, method: "firecrawl" };
    }
  } catch (err) {
    console.warn(`  [article] firecrawl failed for ${host}: ${err}`);
  }

  try {
    const content = await fetchViaWayback(url, host, postedAtMs);
    if (content) {
      console.log(`  [article] fetched via wayback (${content.length} chars)`);
      return { status: "ok", content, method: "wayback" };
    }
  } catch (err) {
    console.warn(`  [article] wayback failed for ${host}: ${err}`);
  }

  return { status: "fetch_failed" };
}
