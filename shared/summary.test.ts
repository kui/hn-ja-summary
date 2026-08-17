import { describe, it, expect } from "vitest";
import {
  parseSummaryDoc,
  renderSummaryHtml,
  validateFragment,
  SummaryFormatError,
} from "./summary.ts";
import type { SummaryDoc } from "./summary.ts";

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
    expect(doc.jaTitle).toBe("日本語タイトル");
    expect(doc.topics.length).toBe(1);
  });

  it("topics が空でも通す", () => {
    const doc = parseSummaryDoc(JSON.stringify(makeDoc({ topics: [] })));
    expect(doc.topics).toEqual([]);
  });

  it("不正なJSONを拒否する", () => {
    expect(() => parseSummaryDoc("{")).toThrow(SummaryFormatError);
  });

  it("配列やnullを拒否する", () => {
    expect(() => parseSummaryDoc("null")).toThrow(SummaryFormatError);
    expect(() => parseSummaryDoc("[]")).toThrow(SummaryFormatError);
  });

  it("フィールド欠落を拒否する", () => {
    expect(() =>
      parseSummaryDoc(JSON.stringify({ jaTitle: "x", topics: [] })),
    ).toThrow(SummaryFormatError);
  });

  it("articleHtml の欠落は許容する", () => {
    // JSON.stringify は undefined のキーを落とす
    const doc = parseSummaryDoc(
      JSON.stringify({ ...makeDoc(), articleHtml: undefined }),
    );
    expect(doc.articleHtml).toBeUndefined();
  });

  it("空の articleHtml は拒否する", () => {
    expect(() =>
      parseSummaryDoc(JSON.stringify(makeDoc({ articleHtml: " " }))),
    ).toThrow(SummaryFormatError);
  });

  it("topics が配列でない場合を拒否する", () => {
    expect(() =>
      parseSummaryDoc(JSON.stringify({ ...makeDoc(), topics: "not array" })),
    ).toThrow(SummaryFormatError);
  });

  it("空の jaTitle を拒否する", () => {
    expect(() =>
      parseSummaryDoc(JSON.stringify(makeDoc({ jaTitle: " " }))),
    ).toThrow(SummaryFormatError);
  });

  it("空の topic heading を拒否する", () => {
    expect(() =>
      parseSummaryDoc(
        JSON.stringify(
          makeDoc({ topics: [{ heading: "", bodyHtml: "<p>x</p>" }] }),
        ),
      ),
    ).toThrow(SummaryFormatError);
  });
});

describe("renderSummaryHtml", () => {
  it("section で囲んだHTMLを生成する", () => {
    const html = renderSummaryHtml(makeDoc(), ARTICLE_URL, HN_URL);
    expect(html).toMatch(/<section id="article">/);
    expect(html).toMatch(/<section id="hn">/);
    expect(html).toMatch(/<section id="topic-1">/);
    expect(html).toMatch(/<h2>日本語タイトル<\/h2>/);
    expect(html).toMatch(/<h3>観点1<\/h3>/);
  });

  it("両方のURLをリンクとして埋め込む", () => {
    const html = renderSummaryHtml(makeDoc(), ARTICLE_URL, HN_URL);
    expect(html).toContain(`<a href="${ARTICLE_URL}">${ARTICLE_URL}</a>`);
    expect(html).toContain(
      '<a href="https://news.ycombinator.com/item?id=1">https://news.ycombinator.com/item?id=1</a>',
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
    expect(html).not.toContain("<script>");
    expect(html).toMatch(/<h3>a &amp; b<\/h3>/);
  });

  it("topics が空でも2つの section を返す", () => {
    const html = renderSummaryHtml(
      makeDoc({ topics: [] }),
      ARTICLE_URL,
      HN_URL,
    );
    expect(html.match(/<section /g)?.length).toBe(2);
  });
});

describe("validateFragment", () => {
  it("許可タグのみの正常な HTML を通す", async () => {
    await expect(
      validateFragment("<p>text <strong>bold</strong></p>"),
    ).resolves.toBeUndefined();
  });

  it("HTML 上合法な閉じタグ省略を通す", async () => {
    await expect(
      validateFragment("<ul><li>a<li>b</ul>"),
    ).resolves.toBeUndefined();
  });

  it("未閉じタグを検知する", async () => {
    await expect(validateFragment("<p>text")).rejects.toThrow(/unclosed tag/);
  });

  it("未終端の属性値が後続を飲み込むケースを検知する", async () => {
    // 閉じられていない href が続く要素を属性値へ飲み込み、その element イベントが
    // 消えることで <p> の onEndTag が発火せず未閉じとして検知される。
    await expect(
      validateFragment('<p><a href="https://example.com>x</a></p>'),
    ).rejects.toThrow(SummaryFormatError);
  });

  it("許可外タグを拒否する", async () => {
    await expect(validateFragment("<div>x</div>")).rejects.toThrow(
      /disallowed tag/,
    );
  });

  it("許可外属性を拒否する", async () => {
    await expect(validateFragment('<p class="x">text</p>')).rejects.toThrow(
      /disallowed attribute/,
    );
  });

  it("javascript: スキームのリンクを拒否する", async () => {
    await expect(
      validateFragment('<a href="javascript:alert(1)">x</a>'),
    ).rejects.toThrow(/disallowed href scheme/);
  });

  it("https の href は通す", async () => {
    await expect(
      validateFragment('<a href="https://example.com">x</a>'),
    ).resolves.toBeUndefined();
  });
});
