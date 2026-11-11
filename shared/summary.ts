import { decodeHtmlEntities, escapeHtml } from "./html.ts";

export interface SummaryTopic {
  heading: string;
  bodyHtml: string;
}

// モデル出力そのもの。元記事本文が無いときは articleHtml をレスポンススキーマから
// 外して生成させないため、そのケースに限り欠落する。
export interface ParsedSummaryDoc {
  jaTitle: string;
  articleHtml?: string;
  hnOverviewHtml: string;
  topics: SummaryTopic[];
}

// レンダリング入力。欠落ケースは呼び出し側が固定の注記で埋めてからここへ渡す。
export interface SummaryDoc extends ParsedSummaryDoc {
  articleHtml: string;
}

export class SummaryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryFormatError";
  }
}

const ALLOWED_TAGS = new Set([
  "p",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "code",
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

export async function validateSummaryDoc(doc: ParsedSummaryDoc): Promise<void> {
  if (doc.articleHtml !== undefined) await validateFragment(doc.articleHtml);
  await validateFragment(doc.hnOverviewHtml);
  for (const topic of doc.topics) {
    await validateFragment(topic.bodyHtml);
  }
}

function requireNonEmpty(value: string, field: string): string {
  if (value.trim() === "") {
    throw new SummaryFormatError(`${field} is empty`);
  }
  return value;
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string") {
    throw new SummaryFormatError(`${field} is not a string`);
  }
  return v;
}

export function parseSummaryDoc(text: string): ParsedSummaryDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SummaryFormatError(`invalid JSON: ${String(err)}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new SummaryFormatError("response is not an object");
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.topics)) {
    throw new SummaryFormatError("topics is not an array");
  }
  return {
    jaTitle: requireNonEmpty(asString(o.jaTitle, "jaTitle"), "jaTitle"),
    articleHtml:
      o.articleHtml === undefined
        ? undefined
        : requireNonEmpty(
            asString(o.articleHtml, "articleHtml"),
            "articleHtml",
          ),
    hnOverviewHtml: requireNonEmpty(
      asString(o.hnOverviewHtml, "hnOverviewHtml"),
      "hnOverviewHtml",
    ),
    topics: o.topics.map((t, i) => {
      if (typeof t !== "object" || t === null) {
        throw new SummaryFormatError(`topics[${i}] is not an object`);
      }
      const to = t as Record<string, unknown>;
      return {
        heading: requireNonEmpty(
          asString(to.heading, `topics[${i}].heading`),
          `topics[${i}].heading`,
        ),
        bodyHtml: asString(to.bodyHtml, `topics[${i}].bodyHtml`),
      };
    }),
  };
}

const INLINE_TAGS = new Set(["strong", "em", "code", "a", "br"]);

// 照合先の中で URL が終わる位置。HN のコメントや記事本文では URL の直後に句読点や
// 閉じ括弧が続くことが多いので、末尾のそれらは URL に含めない。
const SOURCE_URL_PATTERN = /https?:\/\/[!-~]+/g;
const SOURCE_URL_EXCLUDED = /[<>"'`].*$/s;
const SOURCE_URL_TRAILING = /[.,;:!?)\]}*]+$/;

// 末尾のスラッシュとフラグメントの有無は同じ URL として扱う。
// パース時にホストの大文字小文字と、パスの非 ASCII 文字のエンコードも揃う。
function normalizeUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "";
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

function sourceUrls(source: string): Set<string> {
  const urls = new Set<string>();
  for (const [raw] of decodeHtmlEntities(source).matchAll(SOURCE_URL_PATTERN)) {
    const url = normalizeUrl(
      raw.replace(SOURCE_URL_EXCLUDED, "").replace(SOURCE_URL_TRAILING, ""),
    );
    if (url !== null) urls.add(url);
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
 * `<a>` を外してテキストだけ残す。
 */
export async function stripUnsourcedSummaryLinks<T extends ParsedSummaryDoc>(
  doc: T,
  source: string,
): Promise<{ doc: T; removed: RemovedLink[] }> {
  const allowed = sourceUrls(source);
  const removed: RemovedLink[] = [];
  const strip = (html: string, field: string) =>
    stripUnsourcedLinks(html, field, allowed, removed);
  const result: T = {
    ...doc,
    articleHtml:
      doc.articleHtml === undefined
        ? undefined
        : await strip(doc.articleHtml, "articleHtml"),
    hnOverviewHtml: await strip(doc.hnOverviewHtml, "hnOverviewHtml"),
    topics: await Promise.all(
      doc.topics.map(async (topic, i) => ({
        ...topic,
        bodyHtml: await strip(topic.bodyHtml, `topics[${i}].bodyHtml`),
      })),
    ),
  };
  return { doc: result, removed };
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
${wrapLooseText(doc.articleHtml).trim()}
</section>`,
    `<section id="hn">
<h2>HNコミュニティの反応</h2>
${linkList(hnUrl)}
${wrapLooseText(doc.hnOverviewHtml).trim()}
</section>`,
    ...topics,
  ].join("\n");
}
