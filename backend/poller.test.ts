import { env } from "cloudflare:workers";
import { Temporal } from "temporal-polyfill";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduled } from "./poller.ts";
import { queue } from "./processor.ts";

const ERROR_ID = 1;
const FAILED_ID = 2;

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

function mockFetch() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("https://hn.algolia.com/api/v1/search?")) {
      return Response.json({
        hits: [searchHit(ERROR_ID), searchHit(FAILED_ID)],
        nbHits: 2,
      });
    }
    if (url.startsWith("https://hn.algolia.com/api/v1/search_by_date")) {
      return Response.json({ hits: [] });
    }
    if (url.startsWith("https://hn.algolia.com/")) {
      return Response.json({
        id: ERROR_ID,
        title: "Ask HN: Test",
        url: null,
        text: "post body",
        author: "alice",
        points: 10,
        created_at: "2026-01-01T00:00:00Z",
        children: [],
      });
    }
    // 再試行に回らない、一時的でない Gemini のエラー
    return new Response("bad request", { status: 400 });
  });
}

async function poll(): Promise<number[]> {
  const send = vi.fn(async () => {});
  await scheduled(
    {} as ScheduledController,
    { ...env, QUEUE: { send } } as unknown as Env,
    {} as ExecutionContext,
  );
  return send.mock.calls.map(([body]) => (body as { itemId: number }).itemId);
}

async function processOnce(itemId: number): Promise<void> {
  const batch = {
    queue: "hn-processor",
    messages: [
      {
        id: "msg",
        body: { itemId },
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      },
    ],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<{ itemId: number }>;
  await queue(batch, env as Env);
}

async function row(id: number) {
  return env.DB.prepare(
    "SELECT state, error_count FROM processed_items WHERE id = ?",
  )
    .bind(id)
    .first();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM processed_items").run();
  await env.DB.prepare(
    `INSERT INTO processed_items (id, state, created_at_ms, updated_at_ms, error_count)
     VALUES (?, 'error', 1, 1, 2), (?, 'failed', 1, 1, 3)`,
  )
    .bind(ERROR_ID, FAILED_ID)
    .run();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduled", () => {
  it("error は失敗回数を保って再投入し、failed は再投入しない", async () => {
    mockFetch();

    expect(await poll()).toEqual([ERROR_ID]);
    expect(await row(ERROR_ID)).toEqual({ state: "enqueued", error_count: 2 });
    expect(await row(FAILED_ID)).toEqual({ state: "failed", error_count: 3 });
  });

  it("再投入した項目が上限の回数目で失敗したら、次からは再投入しない", async () => {
    mockFetch();

    await poll();
    await processOnce(ERROR_ID);

    expect(await row(ERROR_ID)).toEqual({ state: "failed", error_count: 3 });
    expect(await poll()).toEqual([]);
  });
});
