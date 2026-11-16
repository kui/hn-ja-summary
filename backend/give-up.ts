import { setRetriesExhausted } from "@hn-feed/shared/state";

// 再配信を使い切ったメッセージの送り先。wrangler.toml の dead_letter_queue と合わせる
export const DEAD_LETTER_QUEUE = "hn-processor-dlq";

// error を書けないまま ack すると enqueued のまま残るので、書けなければもう一度配信させる
export async function giveUp(
  message: Message<{ itemId: number }>,
  recordError: () => Promise<void>,
  retryDelaySeconds?: number,
): Promise<void> {
  try {
    await recordError();
    message.ack();
  } catch (dbErr) {
    console.error("Failed to record error state:", dbErr);
    message.retry(
      retryDelaySeconds === undefined
        ? {}
        : { delaySeconds: retryDelaySeconds },
    );
  }
}

// 要約の処理はやり直さず、諦めたことだけを残す
export async function deadLetterQueue(
  batch: MessageBatch<{ itemId: number }>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const { itemId } = message.body;
    console.error(`Retries exhausted for ${itemId}, giving up`);
    await giveUp(message, () =>
      setRetriesExhausted(
        env.DB,
        itemId,
        "Queue の再配信を使い切った（最後の配信はエラーを記録せずに終わった）",
      ),
    );
  }
}
