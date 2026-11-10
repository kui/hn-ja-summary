// ページのバイト列を文字列に戻す。文字コードは WHATWG の判別手順を簡略化して決める。

// 本文は最終的に 15,000 文字に切り詰めるので、巨大なページを全部読む必要はない。
// 全体を読むと Workers のメモリ上限（128MB）を超えて isolate ごと止まりうる
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// WHATWG の prescan が <meta charset> を探す範囲
const PRESCAN_BYTES = 1024;
// 文字コードを判別できずに文字化けした本文は、別の経路で読み直したほうがよい
const MAX_REPLACEMENT_SHARE = 0.01;

async function readBytes(
  resp: Response,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = resp.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = true;
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      truncated = false;
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  if (truncated) await reader.cancel();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: bytes.subarray(0, MAX_BODY_BYTES), truncated };
}

// TextDecoder が知らないラベルは null にして、次の手がかりへ進ませる
function resolveEncoding(label: string): string | null {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return null;
  }
}

function encodingFromBom(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

function charsetParam(value: string): string | null {
  const m = value.match(/charset\s*=\s*["']?([^"';\s]+)/i);
  return m ? m[1] : null;
}

function encodingFromContentType(contentType: string): string | null {
  const m = contentType.match(/;\s*charset\s*=\s*["']?([^"';\s]+)/i);
  return m ? resolveEncoding(m[1]) : null;
}

function charsetFromMetaTag(tag: string): string | null {
  // 属性名の直前は空白か引用符か / に限る。data-charset などに一致させない
  const charset = tag.match(/[\s"'/]charset\s*=\s*["']?([^"'\s/>;]+)/i);
  if (charset) return charset[1];
  if (!/[\s"'/]http-equiv\s*=\s*["']?content-type/i.test(tag)) return null;
  const content = tag.match(/[\s"'/]content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return content ? charsetParam(content[1] ?? content[2]) : null;
}

function encodingFromMeta(bytes: Uint8Array): string | null {
  // <meta> は ASCII で書かれるので、どの ASCII 互換の文字コードのページでも
  // UTF-8 として読んでタグを探せる
  const head = new TextDecoder("utf-8")
    .decode(bytes.subarray(0, PRESCAN_BYTES))
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const [tag] of head.matchAll(/<meta[\s/][^>]*>/gi)) {
    const label = charsetFromMetaTag(tag);
    const encoding = label === null ? null : resolveEncoding(label);
    if (encoding === null) continue;
    // meta を ASCII として読めた時点で UTF-16 ではありえない（WHATWG の規定）
    if (encoding.startsWith("utf-16")) return "utf-8";
    if (encoding === "x-user-defined") return "windows-1252";
    return encoding;
  }
  return null;
}

function decodeStrictUtf8(
  bytes: Uint8Array,
  truncated: boolean,
): string | null {
  // 非 ASCII のバイトがなければ、宣言された ASCII 互換の文字コードで読んでも同じ。
  // UTF-16 の本文も ASCII の範囲だけなら UTF-8 として読めてしまうので宣言に任せる
  if (bytes.every((b) => b < 0x80)) return null;
  try {
    // 上限で打ち切ったときは末尾の文字が途中で切れているので、そこは捨てる
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
      {
        stream: truncated,
      },
    );
  } catch {
    return null;
  }
}

function replacementShare(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (const ch of text) if (ch === "�") count++;
  return count / text.length;
}

// 読めない（文字化けしている）なら null
export async function readBodyText(
  resp: Response,
  isHtml: boolean,
): Promise<string | null> {
  const { bytes, truncated } = await readBytes(resp);
  const bom = encodingFromBom(bytes);
  // UTF-8 として正しく読めるバイト列が、実は別の文字コードということはまずない。
  // 中身に関係なく charset=iso-8859-1 を返すサーバーがあるので、宣言より優先する
  const text =
    (bom === null ? decodeStrictUtf8(bytes, truncated) : null) ??
    new TextDecoder(
      bom ??
        encodingFromContentType(resp.headers.get("content-type") ?? "") ??
        (isHtml ? encodingFromMeta(bytes) : null) ??
        "utf-8",
    ).decode(bytes, { stream: truncated });
  return replacementShare(text) > MAX_REPLACEMENT_SHARE ? null : text;
}
