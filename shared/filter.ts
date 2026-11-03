import { Temporal } from "temporal-polyfill";
import type { HNItem } from "./hn.ts";

/*
 * 掲載条件は次の 3 つをすべて満たすこと（AND）。
 * - 投稿から MIN_AGE_HOURS 時間以上たっている（投稿直後のスパイクを避ける）
 * - コメントが MIN_COMMENTS 件以上ある
 * - 投稿からの平均で毎時 VELOCITY_THRESHOLD ポイント以上獲得している
 *
 * 前の 2 つは Algolia の numericFilters で絞る（candidateNumericFilters）。
 * 対象期間の全ストーリーは 1 回で取得できる 1000 件を超えるため。
 * 毎時ポイントは経過時間で変わるので Algolia では絞れず、取得後に shouldProcess で判定する。
 */
export const MIN_AGE_HOURS = 2.0;
export const MIN_COMMENTS = 40;
export const VELOCITY_THRESHOLD = 20; // points per hour
// これより古い記事は候補にしない
export const SEARCH_WINDOW_HOURS = 24;

/** 経過時間とコメント数の条件を、Algolia の numericFilters の形で返す */
export function candidateNumericFilters(nowSec: number): string[] {
  return [
    `created_at_i>=${nowSec - SEARCH_WINDOW_HOURS * 3600}`,
    `created_at_i<=${nowSec - MIN_AGE_HOURS * 3600}`,
    `num_comments>=${MIN_COMMENTS}`,
  ];
}

/**
 * 毎時ポイントの条件を判定する。
 * 経過時間とコメント数は {@link candidateNumericFilters} で取得時に満たしている前提。
 */
export function shouldProcess(item: HNItem): boolean {
  const now = Temporal.Now.instant().epochMilliseconds / 1000;
  const ageHours = (now - item.time) / 3600;
  return item.points / ageHours >= VELOCITY_THRESHOLD;
}
