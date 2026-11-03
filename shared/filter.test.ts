import { describe, it, expect, vi, afterEach } from "vitest";
import { shouldProcess, VELOCITY_THRESHOLD } from "./filter.ts";
import type { HNItem } from "./hn.ts";

const NOW = 1_800_000_000;

function story(ageHours: number, points: number): HNItem {
  return {
    id: 1,
    type: "story",
    by: "alice",
    time: NOW - ageHours * 3600,
    points,
    descendants: 0,
  };
}

describe("shouldProcess", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function atNow() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
  }

  it("毎時ポイントがちょうど閾値なら掲載する", () => {
    atNow();
    expect(shouldProcess(story(3, VELOCITY_THRESHOLD * 3))).toBe(true);
  });

  it("毎時ポイントが閾値に届かなければ掲載しない", () => {
    atNow();
    expect(shouldProcess(story(3, VELOCITY_THRESHOLD * 3 - 1))).toBe(false);
  });

  it("同じポイントでも経過時間が長いほど毎時ポイントは下がる", () => {
    atNow();
    const points = VELOCITY_THRESHOLD * 4;
    expect(shouldProcess(story(4, points))).toBe(true);
    expect(shouldProcess(story(5, points))).toBe(false);
  });
});
