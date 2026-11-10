import { describe, expect, it } from "vitest";
import { readBodyText } from "./decode.ts";

const TEXT = "本文です。".repeat(50);
const encoder = new TextEncoder();
// TextEncoder は UTF-8 しか出力できないため、非 UTF-8 の本文はバイト列で用意する。
// "本文です。" の Shift_JIS / EUC-JP エンコード
const SJIS = new Uint8Array([150, 123, 149, 182, 130, 197, 130, 183, 129, 66]);
const EUCJP = new Uint8Array([
  203, 220, 202, 184, 164, 199, 164, 185, 161, 163,
]);

function concat(...parts: (Uint8Array | string)[]): Uint8Array {
  const bytes = parts.map((p) =>
    typeof p === "string" ? encoder.encode(p) : p,
  );
  const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of bytes) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

function repeat(bytes: Uint8Array, count: number): Uint8Array {
  return concat(...Array<Uint8Array>(count).fill(bytes));
}

function page(head: string, body: Uint8Array | string): Uint8Array {
  return concat(`<html><head>${head}</head><body>`, body, "</body></html>");
}

function read(bytes: Uint8Array, contentType: string, isHtml = true) {
  return readBodyText(
    new Response(bytes, { headers: { "content-type": contentType } }),
    isHtml,
  );
}

describe("readBodyText", () => {
  it.each([
    ["Content-Type の Shift_JIS", "text/html; charset=Shift_JIS", "", SJIS],
    ["Content-Type の EUC-JP", "text/html; charset=EUC-JP", "", EUCJP],
    ["<meta charset>", "text/html", '<meta charset="Shift_JIS">', SJIS],
    [
      "http-equiv の meta",
      "text/html",
      '<meta http-equiv="Content-Type"\n content="text/html; charset=EUC-JP">',
      EUCJP,
    ],
    [
      "無効なヘッダのラベルの後ろの meta",
      "text/html; charset=cp932",
      '<meta charset="Shift_JIS">',
      SJIS,
    ],
    [
      "コメントの中の meta を無視した後ろの meta",
      "text/html",
      '<!-- <meta charset="EUC-JP"> --><meta charset="Shift_JIS">',
      SJIS,
    ],
    [
      "data-charset を無視した後ろの meta",
      "text/html",
      '<meta data-charset="EUC-JP"><meta charset="Shift_JIS">',
      SJIS,
    ],
    [
      "meta と食い違うヘッダ",
      "text/html; charset=Shift_JIS",
      '<meta charset="EUC-JP">',
      SJIS,
    ],
  ])("%s で文字コードを決める", async (_name, contentType, head, encoded) => {
    const text = await read(page(head, repeat(encoded, 50)), contentType);

    expect(text).toContain(TEXT);
  });

  it.each([
    ["ヘッダが iso-8859-1", "text/html; charset=iso-8859-1", ""],
    ["meta が utf-16", "text/html", '<meta charset="utf-16">'],
    [
      "meta が unicode（utf-16 の別名）",
      "text/html",
      '<meta http-equiv="Content-Type" content="text/html; charset=unicode">',
    ],
    ["ヘッダが知らないラベル", "text/html; charset=Unknown-Charset", ""],
  ])(
    "%s でも UTF-8 の本文は UTF-8 として読む",
    async (_name, contentType, head) => {
      const text = await read(page(head, TEXT), contentType);

      expect(text).toContain(TEXT);
    },
  );

  it("BOM はヘッダより優先する", async () => {
    const bytes = concat(
      new Uint8Array([0xff, 0xfe]),
      new Uint8Array(
        new Uint16Array([...TEXT].map((c) => c.charCodeAt(0))).buffer,
      ),
    );

    expect(await read(bytes, "text/html; charset=Shift_JIS")).toBe(TEXT);
  });

  it("text/plain では本文中の meta の文字列を手がかりにしない", async () => {
    const bytes = concat('<meta charset="EUC-JP"> ', repeat(EUCJP, 50));

    expect(await read(bytes, "text/plain", false)).toBeNull();
  });

  it("文字コードを判別できず文字化けしたら null を返す", async () => {
    expect(await read(page("", repeat(SJIS, 50)), "text/html")).toBeNull();
  });

  it("5MB を超える本文はそこで打ち切り、途中で切れた末尾の文字は捨てる", async () => {
    // 3 バイトの「本」を並べ、5MB の境界が文字の途中に来るようにする
    const bytes = encoder.encode("本".repeat(2 * 1024 * 1024));

    const text = await read(bytes, "text/plain", false);

    expect(text).not.toBeNull();
    expect(text).toBe("本".repeat(Math.floor((5 * 1024 * 1024) / 3)));
  });
});
