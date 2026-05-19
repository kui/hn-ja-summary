import { Temporal } from "temporal-polyfill";
import type { HNItem } from "./hn";

export const VELOCITY_THRESHOLD = 40; // points per hour
export const MIN_AGE_HOURS = 1.0;
export const MIN_COMMENTS = 10;

/**
 * 時間当たり　{@link VELOCITY_THRESHOLD} ポイント獲得している記事を抽出
 * ただし、投稿直後のスパイクを避けるために、投稿から時間が経っている（時間経過かコメント数）ことも判定に入れている。
 */
export function shouldProcess(item: HNItem): boolean {
  const now = Temporal.Now.instant().epochMilliseconds / 1000;
  const ageHours = (now - item.time) / 3600;
  const velocity = ageHours > 0.1 ? item.score / ageHours : 0;

  if (velocity < VELOCITY_THRESHOLD) return false;

  const ageOk = ageHours >= MIN_AGE_HOURS;
  const commentsOk = (item.descendants ?? 0) >= MIN_COMMENTS;

  return ageOk || commentsOk;
}
