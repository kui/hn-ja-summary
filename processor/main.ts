import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import process from "node:process";
import { fetchHNItemWithComments, flattenTopComments } from "./hn.ts";
import type { ArticleResult } from "./article.ts";
import { fetchArticleContent } from "./article.ts";
import { GeminiQuotaError, generateSummary, MODEL } from "./gemini.ts";
import { CloudflareKV } from "./cloudflare-kv.ts";
import { FirestoreClient } from "../shared/firestore.ts";
import type { FeedItem, ProcessRequest } from "../shared/types.ts";

const {
  GEMINI_API_KEY,
  JINA_API_KEY,
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_KV_NAMESPACE_ID,
  CLOUDFLARE_API_TOKEN,
  WORKERS_DOMAIN,
  GCP_PROJECT_ID,
  MAX_COMMENTS,
} = process.env;

const maxComments = parseInt(MAX_COMMENTS ?? "20", 10);

if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required");
if (!CLOUDFLARE_ACCOUNT_ID) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
}
if (!CLOUDFLARE_KV_NAMESPACE_ID) {
  throw new Error("CLOUDFLARE_KV_NAMESPACE_ID is required");
}
if (!CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is required");
if (!WORKERS_DOMAIN) throw new Error("WORKERS_DOMAIN is required");
if (!GCP_PROJECT_ID) throw new Error("GCP_PROJECT_ID is required");

const kv = new CloudflareKV(
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_KV_NAMESPACE_ID,
  CLOUDFLARE_API_TOKEN,
  WORKERS_DOMAIN,
);

const firestore = new FirestoreClient(GCP_PROJECT_ID);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
    );
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function handleProcess(body: ProcessRequest): Promise<void> {
  const { itemId } = body;
  console.log(`Processing item ${itemId}`);

  const algoliaItem = await fetchHNItemWithComments(itemId);
  if (!algoliaItem) {
    await firestore.setSkipped(itemId, "HN item not found");
    return;
  }

  const title = algoliaItem.title ?? `HN Item ${itemId}`;

  const hnUrl = `https://news.ycombinator.com/item?id=${itemId}`;
  const articleUrl = algoliaItem.url ?? hnUrl;

  const postText = algoliaItem.text
    ? algoliaItem.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    : null;

  let article: ArticleResult;
  if (algoliaItem.url) {
    console.log(`Fetching article: ${algoliaItem.url}`);
    const urlArticle = await fetchArticleContent(algoliaItem.url, JINA_API_KEY);
    console.log(`  [article] url status: ${urlArticle.status}`);
    if (postText) {
      const combined = urlArticle.status === "ok"
        ? `${postText}\n\n[リンク先の内容]\n${urlArticle.content}`
        : postText;
      article = { status: "ok", content: combined };
      console.log(`  [article] combined post text with url content`);
    } else {
      article = urlArticle;
    }
  } else if (postText) {
    article = { status: "ok", content: postText };
    console.log(`  [article] using post text (${postText.length} chars)`);
  } else {
    article = { status: "no_url" };
  }

  const comments = flattenTopComments(algoliaItem.children ?? [], maxComments);
  console.log(`Got ${comments.length} comments`);

  console.log("Generating summary with Gemini...");
  const summaryHtml = await generateSummary(
    GEMINI_API_KEY!,
    itemId,
    title,
    articleUrl,
    article,
    comments,
  );

  const feedItem: FeedItem = {
    id: itemId,
    title,
    articleUrl,
    hnUrl,
    summaryHtml,
    processedAt: new Date().toISOString(),
    model: MODEL,
  };

  console.log("Updating Cloudflare KV...");
  await kv.addFeedItem(feedItem);

  await firestore.setCompleted(itemId);
  console.log(`Done: ${itemId} — ${title}`);
}

async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "POST" && url.pathname === "/process") {
    const rawBody = await readBody(req);
    let itemId: number | undefined;
    try {
      const body = JSON.parse(rawBody) as ProcessRequest;
      itemId = body.itemId;
      await handleProcess(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      if (err instanceof GeminiQuotaError) {
        // Gemini の無料枠クォータ超過 → 429 を返して Cloud Tasks に適切なバックオフでリトライさせる
        // Firestore にエラー状態は記録しない（アイテム自体の問題ではないため）
        console.warn(
          "Gemini quota exceeded, returning 429 to Cloud Tasks:",
          String(err),
        );
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err), retryable: true }));
        return;
      }
      console.error("Processing error:", err);
      if (itemId !== undefined) {
        try {
          await firestore.setError(itemId, String(err));
        } catch (fsErr) {
          console.error("Failed to record error state:", fsErr);
        }
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

const port = parseInt(process.env.PORT ?? "8080", 10);

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  handler(req, res).catch((err) => {
    console.error("Unhandled error:", err);
    res.writeHead(500);
    res.end();
  });
});

server.listen(port, () => {
  console.log(`Processor listening on port ${port}`);
});
