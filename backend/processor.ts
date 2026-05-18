import {
  fetchHNItemWithComments,
  flattenTopComments,
} from "@hn-feed/shared/hn";
import type { FeedItem } from "@hn-feed/shared/feed";
import { fetchArticleContent } from "./article";
import { GeminiQuotaError, generateSummary, MODEL } from "./gemini";
import { setCompleted, setError, setSkipped } from "./state";

// 要約に含めるコメント最大数
const MAX_COMMENTS = 100;

async function upsertFeedItem(db: D1Database, item: FeedItem): Promise<void> {
  await db
    .prepare(
      `INSERT INTO feed_items
        (id, created_at_ms, title, article_url, hn_url, summary_html, model)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        article_url = excluded.article_url,
        hn_url = excluded.hn_url,
        summary_html = excluded.summary_html,
        model = excluded.model`,
    )
    .bind(
      item.id,
      item.createdAt,
      item.title,
      item.articleUrl,
      item.hnUrl,
      item.summaryHtml,
      item.model,
    )
    .run();
}

async function processItem(itemId: number, env: Env): Promise<void> {
  console.log(`Processing item ${itemId}`);

  const algoliaItem = await fetchHNItemWithComments(itemId);
  if (!algoliaItem) {
    await setSkipped(env.DB, itemId, "HN item not found");
    return;
  }

  const title = algoliaItem.title ?? `HN Item ${itemId}`;
  const hnUrl = `https://news.ycombinator.com/item?id=${itemId}`;
  const articleUrl = algoliaItem.url ?? hnUrl;

  const postText = algoliaItem.text
    ? algoliaItem.text
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : null;

  let article;
  if (algoliaItem.url) {
    console.log(`Fetching article: ${algoliaItem.url}`);
    const urlArticle = await fetchArticleContent(
      algoliaItem.url,
      env.JINA_API_KEY,
    );
    console.log(`  [article] url status: ${urlArticle.status}`);
    if (postText) {
      const combined =
        urlArticle.status === "ok"
          ? `${postText}\n\n[リンク先の内容]\n${urlArticle.content}`
          : postText;
      article = { status: "ok" as const, content: combined };
      console.log(`  [article] combined post text with url content`);
    } else {
      article = urlArticle;
    }
  } else if (postText) {
    article = { status: "ok" as const, content: postText };
    console.log(`  [article] using post text (${postText.length} chars)`);
  } else {
    article = { status: "no_url" as const };
  }

  const comments = flattenTopComments(algoliaItem.children ?? [], MAX_COMMENTS);
  console.log(`Got ${comments.length} comments`);

  console.log("Generating summary with Gemini...");
  const summaryHtml = await generateSummary(
    env.GEMINI_API_KEY,
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
    createdAt: Date.now(),
    model: MODEL,
  };

  console.log("Writing to D1...");
  await upsertFeedItem(env.DB, feedItem);
  await setCompleted(env.DB, itemId);
  console.log(`Done: ${itemId} — ${title}`);
}

export async function queue(
  batch: MessageBatch<{ itemId: number }>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const { itemId } = message.body;
    try {
      await processItem(itemId, env);
      message.ack();
    } catch (err) {
      if (err instanceof GeminiQuotaError) {
        console.warn(`Gemini quota exceeded for ${itemId}, retrying in 60s`);
        message.retry({ delaySeconds: 60 });
      } else {
        console.error(`Processing error for ${itemId}:`, err);
        try {
          await setError(env.DB, itemId, String(err));
        } catch (dbErr) {
          console.error("Failed to record error state:", dbErr);
        }
        message.ack();
      }
    }
  }
}
