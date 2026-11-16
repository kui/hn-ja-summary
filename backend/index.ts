import { DEAD_LETTER_QUEUE, deadLetterQueue } from "./give-up";
import { scheduled } from "./poller";
import { queue as processorQueue } from "./processor";

// Worker の queue ハンドラは 1 つなので、どの Queue から来たかで振り分ける
async function queue(
  batch: MessageBatch<{ itemId: number }>,
  env: Env,
): Promise<void> {
  if (batch.queue === DEAD_LETTER_QUEUE) {
    await deadLetterQueue(batch, env);
  } else {
    await processorQueue(batch, env);
  }
}

export default { scheduled, queue };
