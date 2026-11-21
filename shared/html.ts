export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// HTML5 の名前付き文字参照は 2,000 以上あるが、記事の本文に実際に現れるのは
// 記号や引用符のごく一部なので、それだけを持つ
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
  larr: "←",
  rarr: "→",
  deg: "°",
  plusmn: "±",
  sect: "§",
  para: "¶",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(
    /&(?:([a-z][a-z0-9]*)|#(\d+)|#x([0-9a-f]+));/gi,
    (
      m,
      name: string | undefined,
      dec: string | undefined,
      hex: string | undefined,
    ) => {
      if (name !== undefined) return HTML_ENTITIES[name.toLowerCase()] ?? m;
      const code = dec !== undefined ? Number(dec) : parseInt(hex ?? "", 16);
      // HTML の仕様と同じく、NUL・サロゲート・範囲外は U+FFFD にする
      const invalid =
        code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff;
      return invalid ? "�" : String.fromCodePoint(code);
    },
  );
}

// エンティティのデコードはタグを除いたあとに 1 回だけ行う。先にデコードすると、
// 本文中の &lt;b&gt; がタグとして消える
export function htmlToText(html: string): string {
  return decodeHtmlEntities(stripHtml(html));
}
