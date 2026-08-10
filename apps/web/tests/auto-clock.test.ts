import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_CLOCK_RATES,
  AutoClockScheduler,
  type AutoClockRate,
} from "../src/app/auto-clock";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("automatic clock scheduler", () => {
  it.each(AUTO_CLOCK_RATES)(
    "runs two serialized phases per cycle at %s cycles/s",
    async (rate) => {
      vi.useFakeTimers();
      const advancePhase = vi.fn();
      const scheduler = new AutoClockScheduler({ advancePhase, rate });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000 / rate);

      expect(advancePhase).toHaveBeenCalledTimes(2);
      expect(scheduler.state).toEqual({
        status: "running",
        rate,
      });
      scheduler.dispose();
    },
  );

  it("rejects rates outside the supported presets without changing cadence", async () => {
    vi.useFakeTimers();
    const advancePhase = vi.fn();
    const scheduler = new AutoClockScheduler({ advancePhase, rate: 1 });
    scheduler.start();

    expect(() => scheduler.setRate(3 as AutoClockRate)).toThrow(
      /unsupported automatic clock rate/i,
    );
    await vi.advanceTimersByTimeAsync(500);

    expect(advancePhase).toHaveBeenCalledTimes(1);
    expect(scheduler.state.rate).toBe(1);
    scheduler.dispose();
  });

  it("starts, pauses, and restarts without accumulating paused time", async () => {
    vi.useFakeTimers();
    const advancePhase = vi.fn();
    const scheduler = new AutoClockScheduler({ advancePhase, rate: 2 });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(250);
    scheduler.pause();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(advancePhase).toHaveBeenCalledTimes(1);
    expect(scheduler.state.status).toBe("paused");

    scheduler.start();
    await vi.advanceTimersByTimeAsync(249);
    expect(advancePhase).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(advancePhase).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("never overlaps asynchronous phase commands", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const advancePhase = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          activeCalls += 1;
          maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
          releases.push(() => {
            activeCalls -= 1;
            resolve();
          });
        }),
    );
    const scheduler = new AutoClockScheduler({ advancePhase, rate: 20 });

    scheduler.start();
    vi.advanceTimersByTime(25);
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();

    expect(advancePhase).toHaveBeenCalledTimes(1);
    expect(maximumActiveCalls).toBe(1);

    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(advancePhase).toHaveBeenCalledTimes(2);
    expect(maximumActiveCalls).toBe(1);

    releases.shift()?.();
    await Promise.resolve();
    scheduler.dispose();
  });

  it("bounds catch-up to two phases and drops older wall-clock lag", async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    const advancePhase = vi.fn();
    const scheduler = new AutoClockScheduler({
      advancePhase,
      rate: 20,
      now: () => monotonicNow,
    });

    scheduler.start();
    monotonicNow = 10_000;
    await vi.advanceTimersByTimeAsync(25);

    expect(advancePhase).toHaveBeenCalledTimes(2);

    monotonicNow = 10_024;
    await vi.advanceTimersByTimeAsync(24);
    expect(advancePhase).toHaveBeenCalledTimes(2);
    monotonicNow = 10_025;
    await vi.advanceTimersByTimeAsync(1);
    expect(advancePhase).toHaveBeenCalledTimes(3);
    scheduler.dispose();
  });

  it("pauses and reports a rejected phase command", async () => {
    vi.useFakeTimers();
    const failure = new Error("WASM phase failed");
    const onError = vi.fn();
    const advancePhase = vi.fn().mockRejectedValue(failure);
    const scheduler = new AutoClockScheduler({
      advancePhase,
      onError,
      rate: 1,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(advancePhase).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(scheduler.state.status).toBe("paused");
    scheduler.dispose();
  });

  it("suspends while hidden and resumes from a fresh deadline only when requested", async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState,
    );
    const advancePhase = vi.fn();
    const scheduler = new AutoClockScheduler({ advancePhase, rate: 2 });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(250);
    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(advancePhase).toHaveBeenCalledTimes(1);
    expect(scheduler.state.status).toBe("suspended");

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(249);
    expect(advancePhase).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(advancePhase).toHaveBeenCalledTimes(2);

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    scheduler.pause();
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(advancePhase).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("applies rate changes from a new deterministic phase deadline", async () => {
    vi.useFakeTimers();
    const advancePhase = vi.fn();
    const scheduler = new AutoClockScheduler({ advancePhase, rate: 1 });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(200);
    scheduler.setRate(5);
    await vi.advanceTimersByTimeAsync(99);
    expect(advancePhase).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(advancePhase).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(advancePhase).toHaveBeenCalledTimes(2);
    expect(scheduler.state.rate).toBe(5);
    scheduler.dispose();
  });

  it("disposes timers and the visibility listener permanently", async () => {
    vi.useFakeTimers();
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const advancePhase = vi.fn();
    const scheduler = new AutoClockScheduler({ advancePhase, rate: 20 });

    scheduler.start();
    scheduler.dispose();
    scheduler.start();
    scheduler.setRate(1);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(advancePhase).not.toHaveBeenCalled();
    expect(scheduler.state).toEqual({ status: "disposed", rate: 20 });
    expect(removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
  });
});
