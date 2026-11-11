import { describe, it, expect } from "vitest";
import {
  parseSummaryDoc,
  renderSummaryHtml,
  wrapLooseText,
  validateFragment,
  SummaryFormatError,
  stripUnsourcedSummaryLinks,
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

  it("p で囲まれていない本文・総括・観点を p で包む", () => {
    const html = renderSummaryHtml(
      makeDoc({
        articleHtml: "記事の要約。",
        hnOverviewHtml: "議論の総括。",
        topics: [{ heading: "観点1", bodyHtml: "観点の説明。" }],
      }),
      ARTICLE_URL,
      HN_URL,
    );
    expect(html).toContain("<p>記事の要約。</p>");
    expect(html).toContain("<p>議論の総括。</p>");
    expect(html).toContain("<p>観点の説明。</p>");
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

describe("wrapLooseText", () => {
  it("p で囲まれていない地の文を p で包む", () => {
    expect(wrapLooseText("記事の要約。")).toBe("<p>記事の要約。</p>");
  });

  it("インライン要素は地の文と一緒に包む", () => {
    expect(
      wrapLooseText(
        '<strong>A</strong>は<a href="https://x.test/">B</a>。<br>C',
      ),
    ).toBe('<p><strong>A</strong>は<a href="https://x.test/">B</a>。<br>C</p>');
  });

  it("ブロック要素の前後に分かれた地の文をそれぞれ包む", () => {
    expect(
      wrapLooseText("前文\n<ul><li>要点<ul><li>詳細</li></ul></li></ul>\n後文"),
    ).toBe(
      "<p>前文</p><ul><li>要点<ul><li>詳細</li></ul></li></ul><p>後文</p>",
    );
  });

  it("開きタグのない閉じタグは段落の区切りとして捨てる", () => {
    expect(wrapLooseText("本文。</p>後文<ul><li>x</li></ul>残り")).toBe(
      "<p>本文。</p><p>後文</p><ul><li>x</li></ul><p>残り</p>",
    );
  });

  it("ブロックを囲むインライン要素の並びは包まずに残す", () => {
    expect(wrapLooseText("<strong>見出し<p>段落</p></strong>後文")).toBe(
      "<strong>見出し<p>段落</p></strong>後文",
    );
    expect(
      wrapLooseText(
        '<a href="https://x.test/"><ul><li>項目</li></ul></a><p>次</p>',
      ),
    ).toBe('<a href="https://x.test/"><ul><li>項目</li></ul></a><p>次</p>');
  });

  it("p やブロック要素だけの断片は変えない", () => {
    const html = "<p>一文目。</p>\n<table><tr><td>x</td></tr></table>";
    expect(wrapLooseText(html)).toBe(html);
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

describe("stripUnsourcedSummaryLinks", () => {
  async function strip(html: string, source: string) {
    const { doc, removed } = await stripUnsourcedSummaryLinks(
      { jaTitle: "t", articleHtml: "", hnOverviewHtml: html, topics: [] },
      source,
    );
    return { html: doc.hnOverviewHtml, removed: removed.map((r) => r.href) };
  }

  it("source に現れる URL のリンクはそのまま残す", async () => {
    const html =
      '<p>詳細は <a href="https://example.com/page1">こちら</a>。</p>';
    expect(
      await strip(html, "本文中に https://example.com/page1 がある。"),
    ).toEqual({ html, removed: [] });
  });

  it("source に現れない URL のリンクは a タグだけ外す", async () => {
    expect(
      await strip(
        '<p>詳細は <a href="https://evil.test/x">リンク</a>だ。</p>',
        "https://example.com/page1",
      ),
    ).toEqual({
      html: "<p>詳細は リンクだ。</p>",
      removed: ["https://evil.test/x"],
    });
  });

  it("href のない a タグも外す", async () => {
    expect(await strip("<p><a>no href</a></p>", "x")).toEqual({
      html: "<p>no href</p>",
      removed: [null],
    });
  });

  it.each([
    ["別のドメインになる前方一致", "https://example.co"],
    ["途中で切った URL", "https://github.com/foo"],
    ["スキームだけ", "https://"],
  ])("%sは外す", async (_, href) => {
    const result = await strip(
      `<a href="${href}">x</a>`,
      "see https://example.com/x and https://github.com/foo/bar",
    );
    expect(result).toEqual({ html: "x", removed: [href] });
  });

  it.each([
    [
      "内側だけ照合先にない",
      '<p><a href="https://ok.test/">a<a href="https://evil.test/">b</a></a></p>',
      '<p><a href="https://ok.test/">ab</a></p>',
    ],
    [
      "外側だけ照合先にない",
      '<p><a href="https://evil.test/">a<a href="https://ok.test/">b</a></a></p>',
      '<p>a<a href="https://ok.test/">b</a></p>',
    ],
  ])("入れ子の a タグは内側も照合する（%s）", async (_, html, expected) => {
    expect(await strip(html, "https://ok.test/")).toEqual({
      html: expected,
      removed: ["https://evil.test/"],
    });
  });

  it("userinfo を含む href は外す", async () => {
    expect(
      await strip('<a href="https://u:p@ok.test/">x</a>', "https://ok.test/"),
    ).toEqual({ html: "x", removed: ["https://u:p@ok.test/"] });
  });

  it("http と https は別の URL として扱う", async () => {
    expect(
      await strip('<a href="https://ok.test/">x</a>', "http://ok.test/"),
    ).toEqual({ html: "x", removed: ["https://ok.test/"] });
  });

  it("数値文字参照をデコードした URL で照合する", async () => {
    // デコードせずに照合すると、ブラウザが開く https://x.test/a#zz ではなく https://x.test/a& と照合してしまう
    expect(
      await strip(
        '<a href="https://x.test/a&#35;zz">x</a>',
        "https://x.test/a&",
      ),
    ).toEqual({ html: "x", removed: ["https://x.test/a#zz"] });
  });

  it("閉じタグの空白や単引用符の href も正しく扱う", async () => {
    expect(
      await strip(
        "<p><a href='https://ok.test/a'>a</a > <a href=\"https://evil.test/\">b</a ></p>",
        "https://ok.test/a",
      ),
    ).toEqual({
      html: "<p><a href='https://ok.test/a'>a</a > b</p>",
      removed: ["https://evil.test/"],
    });
  });

  it.each([
    [
      "HN 形式でエンコードされた投稿本文",
      "https:&#x2F;&#x2F;github.com&#x2F;foo&#x2F;bar",
      "https://github.com/foo/bar",
    ],
    [
      "&amp; が残った記事本文",
      "https://x.test/?a=1&amp;b=2",
      "https://x.test/?a=1&amp;b=2",
    ],
    [
      "末尾のスラッシュの有無",
      "https://example.com/x",
      "https://example.com/x/",
    ],
    [
      "フラグメントの有無",
      "https://example.com/x",
      "https://example.com/x#sec",
    ],
    [
      "文末の句点と閉じ括弧",
      "(see https://example.com/x).",
      "https://example.com/x",
    ],
    [
      "Markdown のリンク",
      "[docs](https://example.com/x)",
      "https://example.com/x",
    ],
    [
      "パスの非 ASCII 文字",
      "https://ja.wikipedia.org/wiki/%E6%9D%B1",
      "https://ja.wikipedia.org/wiki/東",
    ],
    [
      "照合先にそのまま書かれた非 ASCII 文字",
      "https://ja.wikipedia.org/wiki/東京 です",
      "https://ja.wikipedia.org/wiki/東京",
    ],
    [
      "URL の直後に続く日本語",
      "https://example.com/xを参照",
      "https://example.com/x",
    ],
    [
      "括弧を含む URL",
      "see https://en.wikipedia.org/wiki/Foo_(bar) ok",
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ],
    [
      "Markdown の括弧を含む URL",
      "[Foo](https://en.wikipedia.org/wiki/Foo_(bar))",
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ],
    [
      "続けて書いた Markdown のリンクの 1 つ目",
      "[a](https://a.test/x)[b](https://b.test/y)",
      "https://a.test/x",
    ],
    [
      "続けて書いた Markdown のリンクの 2 つ目",
      "[a](https://a.test/x)[b](https://b.test/y)",
      "https://b.test/y",
    ],
    [
      "カンマでつないだ URL",
      "https://a.test/x,https://b.test/y",
      "https://b.test/y",
    ],
    [
      "URL の中の URL",
      "https://web.archive.org/web/2020/https://example.com/x",
      "https://example.com/x",
    ],
    ["末尾が * の URL", "https://x.test/a*", "https://x.test/a*"],
    [
      "アポストロフィを含む URL",
      "https://en.wikipedia.org/wiki/O'Brien",
      "https://en.wikipedia.org/wiki/O'Brien",
    ],
    ["数値文字参照", "https://x.test/?a=1&b=2", "https://x.test/?a=1&#38;b=2"],
    [
      "パーセントエンコードの大文字小文字",
      "https://x.test/%E6",
      "https://x.test/%e6",
    ],
  ])("%sでも同じ URL として残す", async (_, source, href) => {
    const html = `<a href="${href}">x</a>`;
    expect(await strip(html, source)).toEqual({ html, removed: [] });
  });

  it("全フィールドを照合し、どのフィールドで外したかを返す", async () => {
    const { doc, removed } = await stripUnsourcedSummaryLinks(
      {
        jaTitle: "t",
        articleHtml: '<p><a href="https://a.test/">a</a></p>',
        hnOverviewHtml: '<p><a href="https://b.test/">b</a></p>',
        topics: [
          { heading: "h1", bodyHtml: "<p>no link</p>" },
          {
            heading: "h2",
            bodyHtml: '<p><a href="https://ok.test/">c</a></p>',
          },
        ],
      },
      "https://ok.test/",
    );
    expect(doc.articleHtml).toBe("<p>a</p>");
    expect(doc.hnOverviewHtml).toBe("<p>b</p>");
    expect(doc.topics[1]?.bodyHtml).toBe(
      '<p><a href="https://ok.test/">c</a></p>',
    );
    expect(removed).toEqual([
      { field: "articleHtml", href: "https://a.test/" },
      { field: "hnOverviewHtml", href: "https://b.test/" },
    ]);
  });
});
