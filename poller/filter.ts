import type { HNItem } from "../shared/types.ts";

const VELOCITY_THRESHOLD = 30; // points per hour
const MIN_AGE_HOURS = 1.0;
const MIN_SCORE = 100;
const MIN_COMMENTS = 50;

export function shouldProcess(item: HNItem): boolean {
  const now = Date.now() / 1000;
  const ageHours = (now - item.time) / 3600;
  const velocity = ageHours > 0.1 ? item.score / ageHours : 0;

  if (velocity < VELOCITY_THRESHOLD) return false;

  const ageOk = ageHours >= MIN_AGE_HOURS;
  const scoreOk = (item.score ?? 0) >= MIN_SCORE;
  const commentsOk = (item.descendants ?? 0) >= MIN_COMMENTS;

  return ageOk || scoreOk || commentsOk;
}
