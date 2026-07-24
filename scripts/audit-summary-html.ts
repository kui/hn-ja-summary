#!/usr/bin/env node
import { readFileSync } from "node:fs";

// wrangler d1 execute --json の出力を読み、配信済み summary_html を検査する。
// HTMLRewriter は Node から呼べないため、ここでは形式判定とタグ対応のみを見る。

interface Row {
  id: number;
  title: string;
  summary_html: string;
}

const VOID_TAGS = new Set(["br", "hr", "img"]);
const TAG =
  /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/;

function findBreakage(html: string): string | null {
  const stack: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const m = TAG.exec(html.slice(lt));
    if (!m) return `malformed tag: ${html.slice(lt, lt + 60)}`;
    const [matched, closing, rawName, , selfClosing] = m;
    const tag = rawName.toLowerCase();
    if (closing) {
      const open = stack.pop();
      if (open !== tag)
        return `unbalanced: </${tag}> closes <${open ?? "nothing"}>`;
    } else if (!VOID_TAGS.has(tag) && !selfClosing) {
      stack.push(tag);
    }
    i = lt + matched.length;
  }
  return stack.length > 0 ? `unclosed: <${stack[stack.length - 1]}>` : null;
}

const input = readFileSync(process.argv[2] ?? 0, "utf-8");
const parsed: unknown = JSON.parse(input);
const rows: Row[] = Array.isArray(parsed)
  ? ((parsed[0] as { results: Row[] }).results ?? [])
  : ((parsed as { result: Array<{ results: Row[] }> }).result?.[0]?.results ??
    []);

let legacy = 0;
let broken = 0;
for (const row of rows) {
  const isLegacy = !row.summary_html.includes('<section id="article">');
  if (isLegacy) legacy++;
  const breakage = findBreakage(row.summary_html);
  if (breakage) {
    broken++;
    console.log(`${row.id}\t${breakage}\t${row.title.slice(0, 60)}`);
  }
}

console.log(`\ntotal: ${rows.length}, legacy: ${legacy}, broken: ${broken}`);
