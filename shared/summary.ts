import { escapeHtml } from "./html.ts";

export interface SummaryTopic {
  heading: string;
  bodyHtml: string;
}

export interface SummaryDoc {
  jaTitle: string;
  articleHtml: string;
  hnOverviewHtml: string;
  topics: SummaryTopic[];
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

// HTMLRewriter は不正なHTMLでも例外を投げず入力をそのまま素通しするため、
// 出力ではなくハンドラの発火状況で判定する。未終端の属性値は後続要素を
// 飲み込み、その要素の element イベント自体が発火しなくなる。
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
  await validateFragment(doc.articleHtml);
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

export function parseSummaryDoc(text: string): SummaryDoc {
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
    articleHtml: requireNonEmpty(
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
${topic.bodyHtml.trim()}
</section>`,
  );

  return [
    `<section id="article">
<h2>${escapeHtml(doc.jaTitle)}</h2>
${linkList(articleUrl)}
${doc.articleHtml.trim()}
</section>`,
    `<section id="hn">
<h2>HNコミュニティの反応</h2>
${linkList(hnUrl)}
${doc.hnOverviewHtml.trim()}
</section>`,
    ...topics,
  ].join("\n");
}
