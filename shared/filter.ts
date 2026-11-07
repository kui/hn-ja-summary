import { Temporal } from "temporal-polyfill";
import type { HNItem } from "./hn.ts";

/*
 * 直近 SEARCH_WINDOW_HOURS 時間に投稿されたストーリーのうち、次の 3 つをすべて満たすものを掲載する（AND）。
 * - 投稿から MIN_AGE_HOURS 時間以上たっている（投稿直後のスパイクを避ける）
 * - コメントが MIN_COMMENTS 件以上ある
 * - 投稿からの平均で毎時 VELOCITY_THRESHOLD ポイント以上獲得している
 *
 * 前の 2 つは取得時に絞る（fetchCandidateStories）。
 * 毎時ポイントは経過時間で変わるので取得時には絞れず、取得後に meetsVelocity で判定する。
 */
export const MIN_AGE_HOURS = 2.0;
export const MIN_COMMENTS = 40;
export const VELOCITY_THRESHOLD = 20; // 毎時ポイント
export const SEARCH_WINDOW_HOURS = 24;

/**
 * 毎時ポイントの条件を判定する。
 * 経過時間とコメント数は取得時に満たしている前提。
 */
export function meetsVelocity(item: HNItem): boolean {
  const now = Temporal.Now.instant().epochMilliseconds / 1000;
  const ageHours = (now - item.time) / 3600;
  return item.points / ageHours >= VELOCITY_THRESHOLD;
}
