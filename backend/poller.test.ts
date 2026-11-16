import { env } from "cloudflare:workers";
import { Temporal } from "temporal-polyfill";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduled } from "./poller.ts";

const NEW_ID = 1;
const ERROR_ID = 2;
const ENQUEUED_ID = 3;

// 掲載条件（毎時ポイント）を満たす候補として返す
function searchHit(id: number) {
  const now = Temporal.Now.instant().epochMilliseconds / 1000;
  return {
    objectID: String(id),
    title: `Ask HN: ${id}`,
    url: null,
    author: "alice",
    points: 1000,
    created_at_i: Math.floor(now - 3 * 3600),
    story_text: "post body",
  };
}

async function poll(
  send: (body: { itemId: number }) => Promise<void> = async () => {},
): Promise<number[]> {
  const sent: number[] = [];
  const recordingSend = vi.fn(async (body: { itemId: number }) => {
    await send(body);
    sent.push(body.itemId);
  });
  await scheduled(
    {} as ScheduledController,
    { ...env, QUEUE: { send: recordingSend } } as unknown as Env,
    {} as ExecutionContext,
  );
  return sent;
}

async function storedState(id: number): Promise<string | null> {
  return env.DB.prepare("SELECT state FROM processed_items WHERE id = ?")
    .bind(id)
    .first<string>("state");
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM processed_items").run();
  await env.DB.prepare(
    `INSERT INTO processed_items (id, state, created_at_ms, updated_at_ms)
     VALUES (?, 'error', 1, 1), (?, 'enqueued', 1, 1)`,
  )
    .bind(ERROR_ID, ENQUEUED_ID)
    .run();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      hits: [searchHit(NEW_ID), searchHit(ERROR_ID), searchHit(ENQUEUED_ID)],
      nbHits: 3,
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduled", () => {
  // 再試行は Queue の再配信だけで行うので、error は再試行を諦めた項目
  it("状態のない項目だけを投入し、error と enqueued は投入しない", async () => {
    expect(await poll()).toEqual([NEW_ID]);
    expect(await storedState(NEW_ID)).toBe("enqueued");
    expect(await storedState(ERROR_ID)).toBe("error");
  });

  // 送ってから書くと、処理が先に終わったとき結果を enqueued で上書きしうる
  it("送る前に enqueued にする", async () => {
    const statesAtSend: (string | null)[] = [];
    await poll(async ({ itemId }) => {
      statesAtSend.push(await storedState(itemId));
    });
    expect(statesAtSend).toEqual(["enqueued"]);
  });

  it("送信に失敗したら error にして、admin から投入し直せるようにする", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await poll(async () => {
        throw new Error("queue is down");
      }),
    ).toEqual([]);
    expect(await storedState(NEW_ID)).toBe("error");
  });
});
