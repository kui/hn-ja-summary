import { fetchCandidateStories } from "@hn-feed/shared/hn";
import {
  MIN_AGE_HOURS,
  MIN_COMMENTS,
  SEARCH_WINDOW_HOURS,
  meetsVelocity,
} from "@hn-feed/shared/filter";
import { Temporal } from "temporal-polyfill";
import { batchGetStates, setEnqueued } from "@hn-feed/shared/state";

export async function scheduled(
  _event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  console.log("Fetching HN candidate stories...");
  // 打ち切りや API エラーは例外のまま実行を失敗させる。次の cron の実行で取り直す
  const items = await fetchCandidateStories({
    searchWindowHours: SEARCH_WINDOW_HOURS,
    minAgeHours: MIN_AGE_HOURS,
    minComments: MIN_COMMENTS,
  });
  console.log(`Got ${items.length} candidate stories`);

  const candidates = items.filter(meetsVelocity);
  console.log(`${candidates.length} candidates after filter`);

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
    return state === undefined;
  });
  console.log(`${toEnqueue.length} items to enqueue`);

  // 送信や D1 への書き込みが失敗したら例外のまま止める。行を書く前に止まった項目は、次の実行でまた候補になる
  for (const item of toEnqueue) {
    const sentAtMs = Temporal.Now.instant().epochMilliseconds;
    await env.QUEUE.send({ itemId: item.id });
    await setEnqueued(env.DB, item.id, sentAtMs);
    console.log(`Enqueued ${item.id}: ${item.title}`);
  }

  console.log(`Done. Enqueued ${toEnqueue.length} items.`);
}
