import type { ScheduledEvent } from "@cloudflare/workers-types";
import { fetchCandidateStories } from "@hn-feed/shared/hn";
import { shouldProcess } from "@hn-feed/shared/filter";
import { batchGetStates, setEnqueued } from "./state";
import type { Env } from "./env";

export async function scheduled(
  _event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  console.log("Fetching HN candidate stories...");
  const items = await fetchCandidateStories();
  console.log(`Got ${items.length} candidate stories`);

  const candidates = items.filter(shouldProcess);
  console.log(`${candidates.length} candidates after velocity filter`);

  if (candidates.length === 0) {
    console.log("No candidates to process");
    return;
  }

  const states = await batchGetStates(
    env.DB,
    candidates.map((i) => i.id),
  );
  console.log(`${states.size} items have existing state`);

  const toEnqueue = candidates.filter((i) => {
    const state = states.get(i.id);
    return state === undefined || state === "error";
  });
  console.log(`${toEnqueue.length} items to enqueue`);

  let enqueued = 0;
  for (const item of toEnqueue) {
    try {
      await env.QUEUE.send({ itemId: item.id });
      await setEnqueued(env.DB, item.id);
      enqueued++;
      console.log(`Enqueued ${item.id}: ${item.title}`);
    } catch (err) {
      console.error(`Failed to enqueue ${item.id}:`, err);
    }
  }

  console.log(`Done. Enqueued ${enqueued} items.`);
}
