import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSummaryDoc,
  renderSummaryHtml,
  SummaryFormatError,
} from "./summary.ts";
import type { SummaryDoc } from "./summary.ts";

// validateFragment は Workers 組み込みの HTMLRewriter を使うため node --test から
// 呼べない。テストは Vitest 移行 (#13) 後に追加する。

const ARTICLE_URL = "https://example.com/post";
const HN_URL = "https://news.ycombinator.com/item?id=1";

function makeDoc(overrides: Partial<SummaryDoc> = {}): SummaryDoc {
  return {
    jaTitle: "日本語タイトル",
    articleHtml: "<p>記事の要約。</p>",
    hnOverviewHtml: "<p>議論の総括。</p>",
    topics: [{ heading: "観点1", bodyHtml: "<ul><li>要点</li></ul>" }],
    ...overrides,
  };
}

describe("parseSummaryDoc", () => {
  it("正常なJSONをパースする", () => {
    const doc = parseSummaryDoc(JSON.stringify(makeDoc()));
    assert.equal(doc.jaTitle, "日本語タイトル");
    assert.equal(doc.topics.length, 1);
  });

  it("topics が空でも通す", () => {
    const doc = parseSummaryDoc(JSON.stringify(makeDoc({ topics: [] })));
    assert.deepEqual(doc.topics, []);
  });

  it("不正なJSONを拒否する", () => {
    assert.throws(() => parseSummaryDoc("{"), SummaryFormatError);
  });

  it("配列やnullを拒否する", () => {
    assert.throws(() => parseSummaryDoc("null"), SummaryFormatError);
    assert.throws(() => parseSummaryDoc("[]"), SummaryFormatError);
  });

  it("フィールド欠落を拒否する", () => {
    assert.throws(
      () => parseSummaryDoc(JSON.stringify({ jaTitle: "x", topics: [] })),
      SummaryFormatError,
    );
  });

  it("topics が配列でない場合を拒否する", () => {
    assert.throws(
      () =>
        parseSummaryDoc(JSON.stringify({ ...makeDoc(), topics: "not array" })),
      SummaryFormatError,
    );
  });

  it("空の jaTitle を拒否する", () => {
    assert.throws(
      () => parseSummaryDoc(JSON.stringify(makeDoc({ jaTitle: " " }))),
      SummaryFormatError,
    );
  });

  it("空の topic heading を拒否する", () => {
    assert.throws(
      () =>
        parseSummaryDoc(
          JSON.stringify(
            makeDoc({ topics: [{ heading: "", bodyHtml: "<p>x</p>" }] }),
          ),
        ),
      SummaryFormatError,
    );
  });
});

describe("renderSummaryHtml", () => {
  it("section で囲んだHTMLを生成する", () => {
    const html = renderSummaryHtml(makeDoc(), ARTICLE_URL, HN_URL);
    assert.match(html, /<section id="article">/);
    assert.match(html, /<section id="hn">/);
    assert.match(html, /<section id="topic-1">/);
    assert.match(html, /<h2>日本語タイトル<\/h2>/);
    assert.match(html, /<h3>観点1<\/h3>/);
  });

  it("両方のURLをリンクとして埋め込む", () => {
    const html = renderSummaryHtml(makeDoc(), ARTICLE_URL, HN_URL);
    assert.ok(html.includes(`<a href="${ARTICLE_URL}">${ARTICLE_URL}</a>`));
    assert.ok(
      html.includes(
        '<a href="https://news.ycombinator.com/item?id=1">https://news.ycombinator.com/item?id=1</a>',
      ),
    );
  });

  it("jaTitle と heading をエスケープする", () => {
    const html = renderSummaryHtml(
      makeDoc({
        jaTitle: "<script>x</script>",
        topics: [{ heading: "a & b", bodyHtml: "<p>x</p>" }],
      }),
      ARTICLE_URL,
      HN_URL,
    );
    assert.ok(!html.includes("<script>"));
    assert.match(html, /<h3>a &amp; b<\/h3>/);
  });

  it("topics が空でも2つの section を返す", () => {
    const html = renderSummaryHtml(
      makeDoc({ topics: [] }),
      ARTICLE_URL,
      HN_URL,
    );
    assert.equal(html.match(/<section /g)?.length, 2);
  });
});
