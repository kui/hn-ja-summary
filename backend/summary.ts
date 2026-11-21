import { decodeHtmlEntities, escapeHtml } from "@hn-feed/shared/html";
import type { MissingArticleStatus } from "./article";

export interface SummaryTopic {
  heading: string;
  bodyHtml: string;
}

// 本文が無いときは要約を持たず、描画時に理由ごとの固定の注記を出す
export type ArticleSummary =
  | { status: "ok"; html: string }
  | { status: MissingArticleStatus };

export interface SummaryDoc {
  jaTitle: string;
  article: ArticleSummary;
  hnOverviewHtml: string;
  topics: SummaryTopic[];
}

export class SummaryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryFormatError";
  }
}

export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "p",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "code",
  "sup",
  "sub",
  "a",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "br",
]);

const VOID_TAGS = new Set(["br"]);

interface OpenElement {
  tag: string;
  closed: boolean;
}

// HTMLRewriter は不正なHTMLでも例外を投げず素通しするので、出力ではなくハンドラの
// 発火で判定する。未終端属性は後続要素を飲み込みその element イベントが消えるため検知できる。
// 閉じタグの交差 (<a><strong></a></strong>) は検知しない: パーサーが </a> で子 strong を暗黙に
// 閉じ、余った </strong> を無視するため、交差した事実がイベント層に残らない。HTML5準拠ブラウザが
// 同じ木に修復するので配信上は無害。厳密に弾くにはソースを走査する自前トークナイザが要る。
export async function validateFragment(html: string): Promise<void> {
  const errors: string[] = [];
  const opened: OpenElement[] = [];

  await new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) {
          errors.push(`disallowed tag: <${tag}>`);
          return;
        }
        for (const [name, value] of el.attributes) {
          if (tag !== "a" || name.toLowerCase() !== "href") {
            errors.push(`disallowed attribute: <${tag} ${name}>`);
          } else if (!/^https?:\/\//.test(value)) {
            errors.push(`disallowed href scheme: ${value}`);
          }
        }
        if (VOID_TAGS.has(tag)) return;
        const entry: OpenElement = { tag, closed: false };
        opened.push(entry);
        el.onEndTag(() => {
          entry.closed = true;
        });
      },
    })
    .transform(new Response(html))
    .text();

  const unclosed = opened.find((e) => !e.closed);
  if (unclosed) errors.push(`unclosed tag: <${unclosed.tag}>`);
  if (errors.length > 0) {
    throw new SummaryFormatError(errors.join("; "));
  }
}

export async function validateSummaryDoc(doc: SummaryDoc): Promise<void> {
  if (doc.article.status === "ok") await validateFragment(doc.article.html);
  await validateFragment(doc.hnOverviewHtml);
  for (const topic of doc.topics) {
    await validateFragment(topic.bodyHtml);
  }
}

const INLINE_TAGS = new Set(["strong", "em", "code", "sup", "sub", "a", "br"]);

// 照合先で URL がどこで終わるかは文字だけでは決められない（`Foo_(bar)` の閉じ括弧は URL の一部、
// `(see https://x/)` の閉じ括弧は地の文）。そこで、空白や HTML の区切りまでを最長の形とし、
// 次の位置で切った形もすべて許可する。どの形も照合先に実際に現れる文字列の先頭部分になる。
// - URL のあとに続きやすい記号（引用符、括弧）と、非 ASCII 文字（日本語の地の文）の手前
// - 途中から始まる別の URL の手前（`a,https://b`、Wayback の URL など）
// - 末尾の句読点や閉じ括弧を削った形
const SOURCE_URL_START = /https?:\/\//g;
const SOURCE_URL_RUN = /[^\s<>"`]+/y;
const SOURCE_URL_CUT = /['()[\]]|[^\x00-\x7f]+/g;
const SOURCE_URL_TRAILING = /[.,;:!?'")\]}*]+$/;

// 末尾のスラッシュ、フラグメント、空のクエリ、既定のポートの有無は同じ URL として扱う。
// パース時にホストの大文字小文字とパスの非 ASCII 文字のエンコードが揃うので、
// パーセントエンコードの大文字小文字だけここで揃える。
// userinfo を含む URL は、照合先にない文字列を href に入れられてしまうので、一致させない。
function normalizeUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username !== "" || u.password !== "") return null;
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "";
  return `${u.protocol}//${u.host}${path}${u.search}`.replace(
    /%[0-9a-f]{2}/gi,
    (m) => m.toUpperCase(),
  );
}

function sourceUrls(text: string): Set<string> {
  const starts = [...text.matchAll(SOURCE_URL_START)].map((m) => m.index);
  const urls = new Set<string>();
  for (const start of starts) {
    SOURCE_URL_RUN.lastIndex = start;
    const run = SOURCE_URL_RUN.exec(text)?.[0] ?? "";
    const ends = [run.length];
    for (const m of run.matchAll(SOURCE_URL_CUT)) ends.push(m.index);
    for (const s of starts) {
      if (s > start && s < start + run.length) ends.push(s - start);
    }
    for (const end of ends) {
      const candidate = run.slice(0, end);
      for (const c of [candidate, candidate.replace(SOURCE_URL_TRAILING, "")]) {
        const url = normalizeUrl(c);
        if (url !== null) urls.add(url);
      }
    }
  }
  return urls;
}

export interface RemovedLink {
  field: string;
  // href 属性のない <a> は null
  href: string | null;
}

async function stripUnsourcedLinks(
  html: string,
  field: string,
  allowed: Set<string>,
  removed: RemovedLink[],
): Promise<string> {
  return new HTMLRewriter()
    .on("a", {
      element(el) {
        // getAttribute はエンティティをデコードしない
        const raw = el.getAttribute("href");
        const href = raw === null ? null : decodeHtmlEntities(raw);
        const url = href === null ? null : normalizeUrl(href);
        if (url !== null && allowed.has(url)) return;
        removed.push({ field, href });
        el.removeAndKeepContent();
      },
    })
    .transform(new Response(html))
    .text();
}

/**
 * 要約中のリンクのうち、href が source（モデルに渡したテキスト）に現れない URL のものは
 * `<a>` を外してテキストだけ残す。source はエンティティをデコード済みのテキストとして扱い、
 * デコードし直さない。
 */
export async function stripUnsourcedSummaryLinks(
  doc: SummaryDoc,
  source: string,
): Promise<{ doc: SummaryDoc; removed: RemovedLink[] }> {
  const allowed = sourceUrls(source);
  const removed: RemovedLink[] = [];
  const strip = (html: string, field: string) =>
    stripUnsourcedLinks(html, field, allowed, removed);
  const article: ArticleSummary =
    doc.article.status === "ok"
      ? { ...doc.article, html: await strip(doc.article.html, "articleHtml") }
      : doc.article;
  const hnOverviewHtml = await strip(doc.hnOverviewHtml, "hnOverviewHtml");
  // ログの順番を出力の順に揃えるため、並行させずに 1 つずつ処理する
  const topics = [];
  for (const [i, topic] of doc.topics.entries()) {
    topics.push({
      ...topic,
      bodyHtml: await strip(topic.bodyHtml, `topics[${i}].bodyHtml`),
    });
  }
  return { doc: { ...doc, article, hnOverviewHtml, topics }, removed };
}

// 一覧ページの概要は <p> から拾うが、モデルは地の文を <p> で囲まずに返すことがある。
// トップレベルに出たテキストとインライン要素の並びを <p> で包む。
// validateFragment は開きタグのない閉じタグも、インライン要素の中のブロックも通すので、
// 前者は捨て、後者を含む並びは <p> と交差させないよう包まずに残す。
export function wrapLooseText(html: string): string {
  const out: string[] = [];
  let loose = "";
  let wrappable = true;
  let blockDepth = 0;
  let inlineDepth = 0;
  const flush = () => {
    out.push(wrappable && loose.trim() ? `<p>${loose.trim()}</p>` : loose);
    loose = "";
    wrappable = true;
  };
  for (const token of html.split(/(<\/?[a-zA-Z][^>]*>)/)) {
    const tag = token.match(/^<(\/?)([a-zA-Z0-9]+)/);
    const name = tag?.[2].toLowerCase();
    const closing = tag?.[1] === "/";
    const isInline = name === undefined || INLINE_TAGS.has(name);
    if (blockDepth === 0 && (isInline || inlineDepth > 0)) {
      loose += token;
      if (!isInline) wrappable = false;
      else if (name !== undefined && name !== "br") {
        inlineDepth = Math.max(0, inlineDepth + (closing ? -1 : 1));
      }
      continue;
    }
    if (!isInline && blockDepth === 0) {
      flush();
      if (closing) continue;
    }
    out.push(token);
    if (!isInline) blockDepth += closing ? -1 : 1;
  }
  flush();
  return out.join("");
}

const MISSING_ARTICLE_NOTICE: Record<MissingArticleStatus, string> = {
  no_url: "この投稿には元記事がないため、以下はHNコメントのみに基づきます。",
  fetch_skipped:
    "元記事の本文を取得していないため、以下はHNコメントのみに基づきます。",
  fetch_failed:
    "元記事の本文を取得できなかったため、以下はHNコメントのみに基づきます。",
};

// class="notice" は feed 側が og:description の生成元から除外するための目印
function articleHtml(article: ArticleSummary): string {
  if (article.status === "ok") return wrapLooseText(article.html).trim();
  return `<p class="notice">${MISSING_ARTICLE_NOTICE[article.status]}</p>`;
}

function linkList(url: string): string {
  const escaped = escapeHtml(url);
  return `<ul><li><a href="${escaped}">${escaped}</a></li></ul>`;
}

export function renderSummaryHtml(
  doc: SummaryDoc,
  articleUrl: string,
  hnUrl: string,
): string {
  const topics = doc.topics.map(
    (topic, i) => `<section id="topic-${i + 1}">
<h3>${escapeHtml(topic.heading)}</h3>
${wrapLooseText(topic.bodyHtml).trim()}
</section>`,
  );

  return [
    `<section id="article">
<h2>${escapeHtml(doc.jaTitle)}</h2>
${linkList(articleUrl)}
${articleHtml(doc.article)}
</section>`,
    `<section id="hn">
<h2>HNコミュニティの反応</h2>
${linkList(hnUrl)}
${wrapLooseText(doc.hnOverviewHtml).trim()}
</section>`,
    ...topics,
  ].join("\n");
}
