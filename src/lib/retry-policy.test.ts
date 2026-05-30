import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MAX_ATTEMPTS,
  computeBackoffMs,
  decideFailureOutcome,
} from "./retry-policy";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeBackoffMs", () => {
  it("grows exponentially with the attempt count", () => {
    // Pin jitter to 0 so we assert the deterministic exponential part.
    vi.spyOn(Math, "random").mockReturnValue(0);

    expect(computeBackoffMs(1)).toBe(1_000); // base * 2^0
    expect(computeBackoffMs(2)).toBe(2_000); // base * 2^1
    expect(computeBackoffMs(3)).toBe(4_000); // base * 2^2
    expect(computeBackoffMs(4)).toBe(8_000); // base * 2^3
  });

  it("caps the delay at one hour", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const oneHour = 60 * 60 * 1_000;

    // A very high attempt count would overflow without the cap.
    expect(computeBackoffMs(50)).toBe(oneHour);
  });

  it("treats attempts <= 0 as the first attempt (no negative exponent)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    expect(computeBackoffMs(0)).toBe(1_000);
    expect(computeBackoffMs(-5)).toBe(1_000);
  });

  it("adds up to 20% jitter on top of the exponential value", () => {
    // random() = 1 => maximum jitter (20%).
    vi.spyOn(Math, "random").mockReturnValue(1);

    // attempt 3 => exponential 4000, +20% jitter => 4800.
    expect(computeBackoffMs(3)).toBe(4_800);
  });

  it("never returns less than the exponential floor", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const result = computeBackoffMs(3);
    expect(result).toBeGreaterThanOrEqual(4_000);
    expect(result).toBeLessThanOrEqual(4_800);
  });
});

describe("decideFailureOutcome", () => {
  it("schedules a retry while under the attempt ceiling", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const outcome = decideFailureOutcome(1, "boom", now);

    expect(outcome.isDeadLetter).toBe(false);
    expect(outcome.data.status).toBe("failed");
    expect(outcome.data.lastError).toBe("boom");
    expect(outcome.data.nextRetryAt).toBeInstanceOf(Date);
    // nextRetryAt must be strictly in the future.
    expect(outcome.data.nextRetryAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("moves to dead_letter exactly at the attempt ceiling", () => {
    const outcome = decideFailureOutcome(MAX_ATTEMPTS, "boom");

    expect(outcome.isDeadLetter).toBe(true);
    expect(outcome.data.status).toBe("dead_letter");
    expect(outcome.data.nextRetryAt).toBeNull();
  });

  it("moves to dead_letter beyond the ceiling", () => {
    const outcome = decideFailureOutcome(MAX_ATTEMPTS + 3, "boom");

    expect(outcome.isDeadLetter).toBe(true);
    expect(outcome.data.status).toBe("dead_letter");
    expect(outcome.data.nextRetryAt).toBeNull();
  });

  it("preserves the error message in both branches", () => {
    expect(decideFailureOutcome(1, "transient").data.lastError).toBe("transient");
    expect(decideFailureOutcome(MAX_ATTEMPTS, "fatal").data.lastError).toBe("fatal");
  });

  it("computes nextRetryAt relative to the provided clock", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const now = new Date("2026-01-01T00:00:00.000Z");

    // attempt 2 => backoff 2000ms with zero jitter.
    const outcome = decideFailureOutcome(2, "boom", now);
    expect(outcome.data.nextRetryAt!.getTime()).toBe(now.getTime() + 2_000);
  });
});
