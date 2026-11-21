import { describe, expect, it } from "vitest";
import { htmlToText } from "./html.ts";

describe("htmlToText", () => {
  it("タグを除いてからエンティティをデコードする", () => {
    expect(
      htmlToText("<p>a &amp; b</p><p>&lt;b&gt;bold&lt;/b&gt; &#x2F; &#39;</p>"),
    ).toBe("a & b <b>bold</b> / '");
  });

  it("エンティティは 1 回だけデコードする", () => {
    expect(htmlToText("&amp;#x2F; &amp;amp;")).toBe("&#x2F; &amp;");
  });

  it("記事によく現れる記号の名前付き参照もデコードする", () => {
    expect(
      htmlToText("<p>It&rsquo;s&nbsp;fast &mdash; really&hellip; &copy;</p>"),
    ).toBe("It’s fast — really… ©");
  });

  it("知らない名前付き参照はそのまま残す", () => {
    expect(htmlToText("&unknownentity; &amp")).toBe("&unknownentity; &amp");
  });

  it("NUL・サロゲート・範囲外の数値参照は U+FFFD にする", () => {
    expect(htmlToText("a&#0;b&#xD800;c&#x110000;d")).toBe("a�b�c�d");
  });
});
