import { Temporal } from "temporal-polyfill";
import {
  countComments,
  fetchHNItemWithComments,
  flattenTopComments,
} from "@hn-feed/shared/hn";
import { stripHtml } from "@hn-feed/shared/html";
import type { FeedItem } from "@hn-feed/shared/feed";
import { setCompleted, setError, setSkipped } from "@hn-feed/shared/state";
import { SummaryFormatError } from "@hn-feed/shared/summary";
import type { ArticleInput } from "./article";
import { fetchArticleContent } from "./article";
import { GeminiUnavailableError, generateSummary, MODEL } from "./gemini";

// 要約に含めるコメント最大数
const MAX_COMMENTS = 100;

// Gemini が一時的に使えないときや、出力の形式が不正だったときの再試行間隔。
// Flex の容量不足は数分〜十数分続きうるので 1 分から倍々に延ばす。回数の上限は wrangler.toml の max_retries。
const RETRY_BASE_DELAY_SECONDS = 60;

function retryDelaySeconds(attempts: number): number {
  return RETRY_BASE_DELAY_SECONDS * 2 ** (attempts - 1);
}

async function upsertFeedItem(db: D1Database, item: FeedItem): Promise<void> {
  await db
    .prepare(
      `INSERT INTO feed_items
        (id, created_at_ms, updated_at_ms, title, article_url, hn_url, summary_html, model,
         hn_posted_at_ms, comment_count, points, comments_used, article_chars,
         article_fetch_method, input_tokens, output_tokens, thoughts_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at_ms = excluded.updated_at_ms,
        title = excluded.title,
        article_url = excluded.article_url,
        hn_url = excluded.hn_url,
        summary_html = excluded.summary_html,
        model = excluded.model,
        hn_posted_at_ms = excluded.hn_posted_at_ms,
        comment_count = excluded.comment_count,
        points = excluded.points,
        comments_used = excluded.comments_used,
        article_chars = excluded.article_chars,
        article_fetch_method = excluded.article_fetch_method,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        thoughts_tokens = excluded.thoughts_tokens`,
    )
    .bind(
      item.id,
      item.createdAt,
      item.updatedAt,
      item.title,
      item.articleUrl,
      item.hnUrl,
      item.summaryHtml,
      item.model,
      item.hnPostedAt,
      item.commentCount,
      item.points,
      item.commentsUsed,
      item.articleChars,
      item.articleFetchMethod,
      item.inputTokens,
      item.outputTokens,
      item.thoughtsTokens,
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
  const hnPostedAt = Temporal.Instant.from(
    algoliaItem.created_at,
  ).epochMilliseconds;
  const commentCount = countComments(algoliaItem);
  const points = algoliaItem.points;

  const postText = algoliaItem.text ? stripHtml(algoliaItem.text) : null;

  let article: ArticleInput;
  let articleFetchMethod: string;
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
      article = { status: "ok", content: combined };
      if (urlArticle.status === "ok") {
        articleFetchMethod = `${urlArticle.method}+post_text`;
      } else if (urlArticle.status === "fetch_skipped") {
        articleFetchMethod = "fetch_skipped+post_text";
      } else {
        articleFetchMethod = "post_text";
      }
      console.log(`  [article] combined post text with url content`);
    } else {
      article = urlArticle;
      articleFetchMethod =
        urlArticle.status === "ok" ? urlArticle.method : urlArticle.status;
    }
  } else if (postText) {
    article = { status: "ok", content: postText };
    articleFetchMethod = "post_text";
    console.log(`  [article] using post text (${postText.length} chars)`);
  } else {
    article = { status: "no_url" };
    articleFetchMethod = "no_url";
  }

  const comments = flattenTopComments(algoliaItem.children ?? [], MAX_COMMENTS);
  console.log(`Got ${comments.length} comments`);

  console.log("Generating summary with Gemini...");
  const { summaryHtml, inputTokens, outputTokens, thoughtsTokens } =
    await generateSummary(
      env.GEMINI_API_KEY,
      itemId,
      title,
      articleUrl,
      article,
      comments,
    );

  const now = Temporal.Now.instant().epochMilliseconds;
  const feedItem: FeedItem = {
    id: itemId,
    title,
    articleUrl,
    hnUrl,
    summaryHtml,
    createdAt: now,
    updatedAt: now,
    model: MODEL,
    hnPostedAt,
    commentCount,
    points,
    commentsUsed: comments.length,
    articleChars: article.status === "ok" ? article.content.length : null,
    articleFetchMethod,
    inputTokens,
    outputTokens,
    thoughtsTokens,
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
      if (
        err instanceof GeminiUnavailableError ||
        err instanceof SummaryFormatError
      ) {
        const delaySeconds = retryDelaySeconds(message.attempts);
        console.warn(
          `${String(err)} for ${itemId} (attempt ${message.attempts}), retrying in ${delaySeconds}s`,
        );
        message.retry({ delaySeconds });
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
