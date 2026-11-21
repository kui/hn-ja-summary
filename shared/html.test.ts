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
});
