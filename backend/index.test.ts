import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEAD_LETTER_QUEUE } from "./give-up.ts";
import worker from "./index.ts";

const ITEM_ID = 1;

const BROKEN_DB = {
  prepare() {
    throw new Error("D1 is down");
  },
};

async function runQueue(queueName: string, testEnv: Env = env as Env) {
  const message = {
    id: "msg",
    body: { itemId: ITEM_ID },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  const batch = {
    queue: queueName,
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<{ itemId: number }>;
  await worker.queue(batch, testEnv);
  return message;
}

async function storedState(): Promise<string | null> {
  return env.DB.prepare("SELECT state FROM processed_items WHERE id = ?")
    .bind(ITEM_ID)
    .first<string>("state");
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM processed_items").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("queue", () => {
  it("dead letter queue から来たら要約の処理をせず error にする", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const message = await runQueue(DEAD_LETTER_QUEUE);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    expect(await storedState()).toBe("error");
  });

  it("dead letter queue で D1 に書けなければ ack せずに再配信させる", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const message = await runQueue(DEAD_LETTER_QUEUE, {
      ...env,
      DB: BROKEN_DB,
    } as unknown as Env);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
  });

  it("dead letter queue では再試行に回したときのエラーを残す", async () => {
    await env.DB.prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, updated_at_ms, error_message)
       VALUES (?, 'enqueued', 1, 1, 'Gemini API error: 503')`,
    )
      .bind(ITEM_ID)
      .run();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runQueue(DEAD_LETTER_QUEUE);

    const row = await env.DB.prepare(
      "SELECT state, error_message FROM processed_items WHERE id = ?",
    )
      .bind(ITEM_ID)
      .first();
    expect(row).toEqual({
      state: "error",
      error_message: "Gemini API error: 503",
    });
  });

  // 同じ項目のメッセージが 2 つあり、片方が先に成功していた場合
  it("dead letter queue に来ても completed の項目は error にしない", async () => {
    await env.DB.prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, updated_at_ms)
       VALUES (?, 'completed', 1, 1)`,
    )
      .bind(ITEM_ID)
      .run();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const message = await runQueue(DEAD_LETTER_QUEUE);

    expect(message.ack).toHaveBeenCalled();
    expect(await storedState()).toBe("completed");
  });

  it("hn-processor から来たら processor が処理する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", { status: 404 }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    const message = await runQueue("hn-processor");

    // HN の投稿が見つからないときに skipped にするのは processor だけ
    expect(message.ack).toHaveBeenCalled();
    expect(await storedState()).toBe("skipped");
  });
});
