import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flattenTopComments } from "./hn.ts";
import type { AlgoliaComment } from "./hn.ts";

function makeComment(
  id: number,
  author: string,
  text: string,
  children: AlgoliaComment[] = [],
): AlgoliaComment {
  return { id, author, text, points: null, created_at: "", children };
}

const LONG = "a".repeat(20); // MIN_TEXT_LENGTH を満たす最小文字列

describe("flattenTopComments", () => {
  it("空配列を渡すと空配列を返す", () => {
    assert.deepEqual(flattenTopComments([], 10), []);
  });

  it("max=0 のとき空配列を返す", () => {
    const c = makeComment(1, "alice", LONG);
    assert.deepEqual(flattenTopComments([c], 0), []);
  });

  it("単一コメントを [author]: text 形式で返す", () => {
    const c = makeComment(1, "alice", "hello world, this is a long comment");
    const result = flattenTopComments([c], 10);
    assert.deepEqual(result, ["[alice]: hello world, this is a long comment"]);
  });

  it("子コメントは2スペースインデントで返す", () => {
    const child = makeComment(2, "bob", LONG);
    const parent = makeComment(1, "alice", LONG, [child]);
    const result = flattenTopComments([parent], 10);
    assert.equal(result[0], `[alice]: ${LONG}`);
    assert.equal(result[1], `  [bob]: ${LONG}`);
  });

  it("孫コメントは4スペースインデントで返す", () => {
    const grandchild = makeComment(3, "carol", LONG);
    const child = makeComment(2, "bob", LONG, [grandchild]);
    const parent = makeComment(1, "alice", LONG, [child]);
    const result = flattenTopComments([parent], 10);
    assert.equal(result[2], `    [carol]: ${LONG}`);
  });

  it("max 件数を超えない", () => {
    const children = [2, 3, 4].map((id) => makeComment(id, "u", LONG));
    const parent = makeComment(1, "alice", LONG, children);
    const result = flattenTopComments([parent], 2);
    assert.equal(result.length, 2);
  });

  it("リーフコメントが MIN_TEXT_LENGTH 未満なら除外する", () => {
    const short = makeComment(1, "alice", "hi"); // 子なし・短い
    const long = makeComment(2, "bob", LONG);
    const result = flattenTopComments([short, long], 10);
    assert.equal(result.length, 1);
    assert.ok(result[0].startsWith("[bob]"));
  });

  it("子ありの親は短くても除外しない", () => {
    const child = makeComment(2, "bob", LONG);
    const shortParent = makeComment(1, "alice", "hi", [child]); // 短いが子あり
    const result = flattenTopComments([shortParent], 10);
    assert.ok(result.some((r) => r.includes("[alice]")));
  });

  it("サブツリーが大きい順にトップレベルを選定する", () => {
    // commentA(subtree=3) > commentB(subtree=1)
    const a1 = makeComment(11, "a1", LONG);
    const a2 = makeComment(12, "a2", LONG);
    const commentA = makeComment(1, "alice", LONG, [a1, a2]);
    const commentB = makeComment(2, "bob", LONG);

    const result = flattenTopComments([commentB, commentA], 10);
    // commentA が先に来る
    assert.ok(result[0].startsWith("[alice]"));
  });

  it("greedy 選定で異なる木をまたいで比較する", () => {
    // commentA(10) > commentB(8) > commentA1(7) > commentA2(3)
    const a2 = makeComment(12, "a2", LONG);
    const a1 = makeComment(11, "a1", LONG, [a2]); // subtree=2
    const commentA = makeComment(1, "alice", LONG, [a1, a2]); // subtree=4 (a1+a2+a2's children...実際の数は別途)

    const b1 = makeComment(21, "b1", LONG);
    const b2 = makeComment(22, "b2", LONG);
    const b3 = makeComment(23, "b3", LONG);
    const commentB = makeComment(2, "bob", LONG, [b1, b2, b3]); // subtree=4

    // max=3: commentA か commentB が先に来て、その子、次に相手のトップ
    const result = flattenTopComments([commentA, commentB], 3);
    assert.equal(result.length, 3);
    assert.ok(result[0].startsWith("[alice]"));
    assert.ok(result[1].startsWith("  [a1]"));
    assert.ok(result[2].startsWith("[bob"));
  });

  it("木構造を維持する（greedy 選定でも返信が正しい親の下に来る）", () => {
    // commentA(subtree=10) commentA1(subtree=7) commentA2(subtree=3) commentB(subtree=8)
    // max=3: greedy は A→B→A1 の順で選定するが出力は A→A1→B の順
    const a2 = makeComment(12, "a2", LONG);
    const a1 = makeComment(11, "a1", LONG, [
      ...Array.from({ length: 6 }, (_, i) => makeComment(100 + i, "u", LONG)),
    ]); // subtree=7
    const commentA = makeComment(1, "alice", LONG, [a1, a2]); // subtree=10

    const commentB = makeComment(2, "bob", LONG, [
      ...Array.from({ length: 7 }, (_, i) => makeComment(200 + i, "u", LONG)),
    ]); // subtree=8

    const result = flattenTopComments([commentA, commentB], 3);
    assert.ok(result[0].startsWith("[alice]"));
    assert.ok(result[1].startsWith("  [a1]"));
    assert.ok(result[2].startsWith("[bob"));
  });

  it("text が null のコメントを無視する", () => {
    const nullText: AlgoliaComment = {
      id: 1,
      author: "alice",
      text: null,
      points: null,
      created_at: "",
      children: [],
    };
    assert.deepEqual(flattenTopComments([nullText], 10), []);
  });

  it("author が null のコメントは [-] として出力する", () => {
    const nullAuthor: AlgoliaComment = {
      id: 1,
      author: null,
      text: LONG,
      points: null,
      created_at: "",
      children: [],
    };
    const result = flattenTopComments([nullAuthor], 10);
    assert.equal(result.length, 1);
    assert.ok(result[0].startsWith("[-]:"), result[0]);
  });

  it("HTML タグをそのまま含める", () => {
    const c = makeComment(
      1,
      "alice",
      "<p>hello <b>world</b></p> this is long enough",
    );
    const result = flattenTopComments([c], 10);
    assert.ok(result[0].includes("hello <b>world</b>"), result[0]);
    assert.ok(result[0].includes("<p>"), result[0]);
  });
});
