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

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(
    /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-f]+));/gi,
    (
      m,
      name: string | undefined,
      dec: string | undefined,
      hex: string | undefined,
    ) => {
      if (name !== undefined) return HTML_ENTITIES[name.toLowerCase()] ?? m;
      const code = dec !== undefined ? Number(dec) : parseInt(hex ?? "", 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : m;
    },
  );
}
