import { setRetriesExhausted } from "@hn-feed/shared/state";

// 再配信を使い切ったメッセージの送り先。wrangler.toml の dead_letter_queue と合わせる
export const DEAD_LETTER_QUEUE = "hn-processor-dlq";

// 要約の処理はやり直さず、諦めたことだけを残す。D1 に書けなければ例外のまま投げ、
// DLQ の再配信（wrangler.toml の max_retries・retry_delay）に任せる
export async function deadLetterQueue(
  batch: MessageBatch<{ itemId: number }>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const { itemId } = message.body;
    console.error(`Retries exhausted for ${itemId}, giving up`);
    await setRetriesExhausted(
      env.DB,
      itemId,
      "Queue の再配信を使い切った（最後の配信はエラーを記録せずに終わった）",
    );
    message.ack();
  }
}
