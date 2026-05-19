import type { HNItem } from "./hn";

export const VELOCITY_THRESHOLD = 50; // points per hour
export const MIN_AGE_HOURS = 1.0;
export const MIN_COMMENTS = 10;

export function shouldProcess(item: HNItem): boolean {
  const now = Temporal.Now.instant().epochMilliseconds / 1000;
  const ageHours = (now - item.time) / 3600;
  const velocity = ageHours > 0.1 ? item.score / ageHours : 0;

  if (velocity < VELOCITY_THRESHOLD) return false;

  const ageOk = ageHours >= MIN_AGE_HOURS;
  const commentsOk = (item.descendants ?? 0) >= MIN_COMMENTS;

  return ageOk || commentsOk;
}
