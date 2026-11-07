import { describe, it, expect, vi, afterEach } from "vitest";
import { MIN_AGE_HOURS, MIN_COMMENTS, SEARCH_WINDOW_HOURS } from "./filter.ts";
import {
  countComments,
  fetchCandidateStories,
  fetchHNItemWithComments,
  flattenTopComments,
} from "./hn.ts";
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
    expect(flattenTopComments([], 10)).toEqual([]);
  });

  it("max=0 のとき空配列を返す", () => {
    const c = makeComment(1, "alice", LONG);
    expect(flattenTopComments([c], 0)).toEqual([]);
  });

  it("単一コメントを [author]: text 形式で返す", () => {
    const c = makeComment(1, "alice", "hello world, this is a long comment");
    const result = flattenTopComments([c], 10);
    expect(result).toEqual(["[alice]: hello world, this is a long comment"]);
  });

  it("子コメントは2スペースインデントで返す", () => {
    const child = makeComment(2, "bob", LONG);
    const parent = makeComment(1, "alice", LONG, [child]);
    const result = flattenTopComments([parent], 10);
    expect(result[0]).toBe(`[alice]: ${LONG}`);
    expect(result[1]).toBe(`  [bob]: ${LONG}`);
  });

  it("孫コメントは4スペースインデントで返す", () => {
    const grandchild = makeComment(3, "carol", LONG);
    const child = makeComment(2, "bob", LONG, [grandchild]);
    const parent = makeComment(1, "alice", LONG, [child]);
    const result = flattenTopComments([parent], 10);
    expect(result[2]).toBe(`    [carol]: ${LONG}`);
  });

  it("max 件数を超えない", () => {
    const children = [2, 3, 4].map((id) => makeComment(id, "u", LONG));
    const parent = makeComment(1, "alice", LONG, children);
    const result = flattenTopComments([parent], 2);
    expect(result.length).toBe(2);
  });

  it("リーフコメントが MIN_TEXT_LENGTH 未満なら除外する", () => {
    const short = makeComment(1, "alice", "hi"); // 子なし・短い
    const long = makeComment(2, "bob", LONG);
    const result = flattenTopComments([short, long], 10);
    expect(result.length).toBe(1);
    expect(result[0].startsWith("[bob]")).toBe(true);
  });

  it("子ありの親は短くても除外しない", () => {
    const child = makeComment(2, "bob", LONG);
    const shortParent = makeComment(1, "alice", "hi", [child]); // 短いが子あり
    const result = flattenTopComments([shortParent], 10);
    expect(result.some((r) => r.includes("[alice]"))).toBe(true);
  });

  it("サブツリーが大きい順にトップレベルを選定する", () => {
    // commentA(subtree=3) > commentB(subtree=1)
    const a1 = makeComment(11, "a1", LONG);
    const a2 = makeComment(12, "a2", LONG);
    const commentA = makeComment(1, "alice", LONG, [a1, a2]);
    const commentB = makeComment(2, "bob", LONG);

    const result = flattenTopComments([commentB, commentA], 10);
    // commentA が先に来る
    expect(result[0].startsWith("[alice]")).toBe(true);
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
    expect(result.length).toBe(3);
    expect(result[0].startsWith("[alice]")).toBe(true);
    expect(result[1].startsWith("  [a1]")).toBe(true);
    expect(result[2].startsWith("[bob")).toBe(true);
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
    expect(result[0].startsWith("[alice]")).toBe(true);
    expect(result[1].startsWith("  [a1]")).toBe(true);
    expect(result[2].startsWith("[bob")).toBe(true);
  });

  it("サブツリーの大きさが同じなら、先に候補になったコメントから選ぶ", () => {
    const a1 = makeComment(11, "a1", LONG);
    const b1 = makeComment(21, "b1", LONG);
    const commentA = makeComment(1, "alice", LONG, [a1]);
    const commentB = makeComment(2, "bob", LONG, [b1]);

    const result = flattenTopComments([commentA, commentB], 3);
    expect(result).toEqual([
      `[alice]: ${LONG}`,
      `  [a1]: ${LONG}`,
      `[bob]: ${LONG}`,
    ]);
  });

  it("同じ大きさの候補は、親を選んだ順に選ぶ", () => {
    // small は入力では先だが、big を先に選ぶので、b2 が s1 より先に候補になる
    const s1 = makeComment(11, "s1", LONG);
    const small = makeComment(1, "small", LONG, [s1]);
    const b11 = makeComment(211, "b11", LONG);
    const b1 = makeComment(21, "b1", LONG, [b11]);
    const b2 = makeComment(22, "b2", LONG);
    const big = makeComment(2, "big", LONG, [b1, b2]);

    expect(flattenTopComments([small, big], 4)).toEqual([
      `[big]: ${LONG}`,
      `  [b1]: ${LONG}`,
      `  [b2]: ${LONG}`,
      `[small]: ${LONG}`,
    ]);
  });

  it("ID が重複していても、選んだコメントだけを出力し、返信を落とさない", () => {
    const q = makeComment(3, "q", LONG);
    const p = makeComment(2, "p", LONG, [q]);
    const short = makeComment(1, "short", "hi");
    const parent = makeComment(1, "parent", LONG, [p]);

    expect(flattenTopComments([short, parent], 10)).toEqual([
      `[parent]: ${LONG}`,
      `  [p]: ${LONG}`,
      `    [q]: ${LONG}`,
    ]);
  });

  it("除外された葉は件数に数えず、次の候補を選ぶ", () => {
    const short = makeComment(11, "short", "hi");
    const long = makeComment(12, "long", LONG);
    const parent = makeComment(1, "alice", LONG, [short, long]);

    const result = flattenTopComments([parent], 2);
    expect(result).toEqual([`[alice]: ${LONG}`, `  [long]: ${LONG}`]);
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
    expect(flattenTopComments([nullText], 10)).toEqual([]);
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
    expect(result.length).toBe(1);
    expect(result[0].startsWith("[-]:")).toBe(true);
  });

  it("HTML タグをそのまま含める", () => {
    const c = makeComment(
      1,
      "alice",
      "<p>hello <b>world</b></p> this is long enough",
    );
    const result = flattenTopComments([c], 10);
    expect(result[0].includes("hello <b>world</b>")).toBe(true);
    expect(result[0].includes("<p>")).toBe(true);
  });
});

describe("fetchCandidateStories", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function hit(objectID: string) {
    return {
      objectID,
      title: `story ${objectID}`,
      url: null,
      author: "alice",
      points: 100,
      created_at_i: 1_700_000_000,
      story_text: null,
    };
  }

  function mockSearch(body: unknown, status = 200) {
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(JSON.stringify(body), { status }),
      );
  }

  it("SEARCH_WINDOW_HOURS 前から MIN_AGE_HOURS 前までのコメント数の条件を満たす記事を 1 リクエストで取得する", async () => {
    const now = 1_800_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now * 1000);
    const fetchMock = mockSearch({ hits: [hit("1")], nbHits: 1 });
    await fetchCandidateStories();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("hitsPerPage")).toBe("1000");
    expect(url.searchParams.get("numericFilters")!.split(",").sort()).toEqual(
      [
        `created_at_i>=${now - SEARCH_WINDOW_HOURS * 3600}`,
        `created_at_i<=${now - MIN_AGE_HOURS * 3600}`,
        `num_comments>=${MIN_COMMENTS}`,
      ].sort(),
    );
  });

  it("ヒットを HNItem に変換して返す", async () => {
    mockSearch({ hits: [hit("1"), hit("2")], nbHits: 2 });
    const items = await fetchCandidateStories();
    expect(items.map((i) => i.id)).toEqual([1, 2]);
    expect(items[0]).toMatchObject({
      type: "story",
      by: "alice",
      points: 100,
      title: "story 1",
    });
  });

  it("取り切れないときだけ警告する", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSearch({ hits: [hit("1")], nbHits: 1 });
    await fetchCandidateStories();
    expect(warn).not.toHaveBeenCalled();

    mockSearch({ hits: [hit("1")], nbHits: 1001 });
    await fetchCandidateStories();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("検索が失敗したら空配列を返す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockSearch({}, 503);
    expect(await fetchCandidateStories()).toEqual([]);
  });
});

describe("fetchHNItemWithComments", () => {
  const STORY_ID = 100;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function hit(id: number, parentId: number) {
    return {
      objectID: String(id),
      author: `user${id}`,
      comment_text: `text ${id}`,
      created_at: "2026-11-07T00:00:00Z",
      parent_id: parentId,
    };
  }

  function mockAlgolia(
    children: AlgoliaComment[] | null,
    search: () => Response | Promise<Response>,
  ) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/search_by_date")) return search();
      return Response.json({
        id: STORY_ID,
        title: "story",
        url: null,
        text: null,
        author: "alice",
        points: 1,
        created_at: "",
        children,
      });
    });
  }

  it("このストーリーのコメントを 1 リクエストで検索する", async () => {
    const fetchMock = mockAlgolia([], () => Response.json({ hits: [] }));
    await fetchHNItemWithComments(STORY_ID);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url = new URL(String(fetchMock.mock.calls[1][0]));
    expect(url.pathname).toBe("/api/v1/search_by_date");
    expect(url.searchParams.get("tags")).toBe(`comment,story_${STORY_ID}`);
    expect(url.searchParams.get("hitsPerPage")).toBe("1000");
  });

  it("親がツリーにあるコメントは親の子に足し、AlgoliaComment の形に変換する", async () => {
    mockAlgolia([makeComment(1, "a", LONG)], () =>
      Response.json({ hits: [hit(2, 1)] }),
    );
    const item = await fetchHNItemWithComments(STORY_ID);

    expect(item!.children).toHaveLength(1);
    expect(item!.children![0].children).toEqual([
      {
        id: 2,
        author: "user2",
        text: "text 2",
        points: null,
        created_at: "2026-11-07T00:00:00Z",
        children: [],
      },
    ]);
  });

  it("親が dead で検索結果にないコメントはトップレベルに足す", async () => {
    const DEAD_ID = 999;
    mockAlgolia([makeComment(1, "a", LONG)], () =>
      Response.json({ hits: [hit(2, DEAD_ID)] }),
    );
    const item = await fetchHNItemWithComments(STORY_ID);

    expect(item!.children!.map((c) => c.id)).toEqual([1, 2]);
    expect(countComments(item!)).toBe(2);
  });

  it("返信が親より先に並んでいても親の子につなぐ", async () => {
    const DEAD_ID = 999;
    mockAlgolia([], () =>
      Response.json({ hits: [hit(4, 3), hit(3, 2), hit(2, DEAD_ID)] }),
    );
    const item = await fetchHNItemWithComments(STORY_ID);

    expect(item!.children!.map((c) => c.id)).toEqual([2]);
    const depth1 = item!.children![0].children;
    expect(depth1.map((c) => c.id)).toEqual([3]);
    expect(depth1[0].children.map((c) => c.id)).toEqual([4]);
    expect(countComments(item!)).toBe(3);
  });

  it("ツリーにあるコメントは重複して足さない", async () => {
    const tree = [makeComment(1, "a", LONG, [makeComment(2, "b", LONG)])];
    mockAlgolia(tree, () =>
      Response.json({ hits: [hit(1, STORY_ID), hit(2, 1)] }),
    );
    const item = await fetchHNItemWithComments(STORY_ID);

    expect(item!.children).toEqual(tree);
  });

  it("children が null のときも検索結果を足す", async () => {
    mockAlgolia(null, () => Response.json({ hits: [hit(2, STORY_ID)] }));
    const item = await fetchHNItemWithComments(STORY_ID);

    expect(item!.children!.map((c) => c.id)).toEqual([2]);
  });

  it("children が null で検索結果もなければ null のままにする", async () => {
    mockAlgolia(null, () => Response.json({ hits: [] }));
    const item = await fetchHNItemWithComments(STORY_ID);

    expect(item!.children).toBeNull();
    expect(countComments(item!)).toBeNull();
  });

  it.each<[string, () => Response | Promise<Response>]>([
    ["HTTP エラー", () => new Response("error", { status: 503 })],
    ["接続エラー", () => Promise.reject(new Error("network"))],
    ["JSON でないレスポンス", () => new Response("<html>")],
    ["hits がないレスポンス", () => Response.json({})],
  ])("検索の%sでは今のツリーだけで続ける", async (_name, search) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tree = [makeComment(1, "a", LONG)];
    mockAlgolia(tree, search);
    const item = await fetchHNItemWithComments(STORY_ID);

    expect(item!.children).toEqual(tree);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("ツリーの取得に失敗したら検索せず null を返す", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("", { status: 404 }));

    expect(await fetchHNItemWithComments(STORY_ID)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
