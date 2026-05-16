import process from "node:process";
import { fetchItemsBatch, fetchTopStoryIds } from "./hn.ts";
import { shouldProcess } from "./filter.ts";
import { FirestoreClient } from "../shared/firestore.ts";
import { CloudTasksClient } from "./tasks.ts";

const projectId = process.env.GCP_PROJECT_ID;
const gcpRegion = process.env.GCP_REGION ?? "asia-northeast1";
const queueId = process.env.CLOUD_TASKS_QUEUE ?? "hn-processor";
const processorUrl = process.env.PROCESSOR_URL;
const serviceAccountEmail = process.env.SERVICE_ACCOUNT_EMAIL;
const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

if (!projectId) throw new Error("GCP_PROJECT_ID is required");
if (!processorUrl) throw new Error("PROCESSOR_URL is required");
if (!serviceAccountEmail) throw new Error("SERVICE_ACCOUNT_EMAIL is required");

const firestore = new FirestoreClient(projectId, serviceAccountKey);
const tasks = new CloudTasksClient(
  projectId,
  gcpRegion,
  queueId,
  processorUrl,
  serviceAccountEmail,
  serviceAccountKey,
);

console.log("Fetching HN top stories...");
const topIds = await fetchTopStoryIds();
console.log(`Got ${topIds.length} top story IDs`);

const candidateIds = topIds.slice(0, 500);

console.log("Fetching item details...");
const items = await fetchItemsBatch(candidateIds, 20);
console.log(`Got ${items.length} story items`);

const candidates = items.filter(shouldProcess);
console.log(`${candidates.length} candidates after velocity filter`);

if (candidates.length === 0) {
  console.log("No candidates to process");
  process.exit(0);
}

const states = await firestore.batchGetStates(candidates.map((i) => i.id));
console.log(`${states.size} items have existing state`);

const toEnqueue = candidates.filter((i) => {
  const state = states.get(i.id);
  // enqueued/completed/skipped はスキップ。error と未登録は再エンキュー対象
  return state === undefined || state === "error";
});
console.log(`${toEnqueue.length} items to enqueue`);

let enqueued = 0;
for (const item of toEnqueue) {
  try {
    await tasks.enqueue(item.id);
    await firestore.setEnqueued(item.id);
    enqueued++;
    console.log(`Enqueued ${item.id}: ${item.title}`);
  } catch (err) {
    console.error(`Failed to enqueue ${item.id}:`, err);
  }
}

console.log(`Done. Enqueued ${enqueued} items.`);
