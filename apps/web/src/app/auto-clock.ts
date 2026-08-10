export const AUTO_CLOCK_RATES = [0.5, 1, 2, 5, 10, 20] as const;

export type AutoClockRate = (typeof AUTO_CLOCK_RATES)[number];
export type AutoClockStatus = "paused" | "running" | "suspended" | "disposed";

export interface AutoClockState {
  status: AutoClockStatus;
  rate: AutoClockRate;
}

interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface AutoClockSchedulerOptions {
  advancePhase: () => unknown | PromiseLike<unknown>;
  rate?: AutoClockRate;
  onError?: (error: unknown) => void;
  now?: () => number;
  visibilitySource?: VisibilitySource | null;
}

const MAX_CATCH_UP_PHASES = 2;

export class AutoClockScheduler {
  private readonly advancePhaseCommand: () => unknown | PromiseLike<unknown>;
  private readonly reportError: (error: unknown) => void;
  private readonly now: () => number;
  private readonly visibilitySource: VisibilitySource | null;
  private selectedRate: AutoClockRate;
  private requestedRunning = false;
  private disposed = false;
  private executing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextDeadline: number | null = null;
  private generation = 0;

  constructor(options: AutoClockSchedulerOptions) {
    assertRate(options.rate ?? 1);
    this.advancePhaseCommand = options.advancePhase;
    this.reportError = options.onError ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.selectedRate = options.rate ?? 1;
    this.visibilitySource =
      options.visibilitySource === undefined
        ? typeof document === "undefined"
          ? null
          : document
        : options.visibilitySource;
    this.visibilitySource?.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
  }

  get state(): AutoClockState {
    if (this.disposed) {
      return { status: "disposed", rate: this.selectedRate };
    }
    if (!this.requestedRunning) {
      return { status: "paused", rate: this.selectedRate };
    }
    return {
      status: this.isHidden() ? "suspended" : "running",
      rate: this.selectedRate,
    };
  }

  start(): void {
    if (this.disposed || this.requestedRunning) {
      return;
    }
    this.requestedRunning = true;
    this.generation += 1;
    this.nextDeadline = this.now() + this.phaseIntervalMs();
    this.scheduleIfReady();
  }

  pause(): void {
    if (this.disposed || !this.requestedRunning) {
      return;
    }
    this.requestedRunning = false;
    this.invalidateSchedule();
  }

  setRate(rate: AutoClockRate): void {
    if (this.disposed) {
      return;
    }
    assertRate(rate);
    if (rate === this.selectedRate) {
      return;
    }
    this.selectedRate = rate;
    this.generation += 1;
    this.clearTimer();
    this.nextDeadline = this.requestedRunning
      ? this.now() + this.phaseIntervalMs()
      : null;
    this.scheduleIfReady();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.requestedRunning = false;
    this.invalidateSchedule();
    this.visibilitySource?.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.disposed || !this.requestedRunning) {
      return;
    }
    this.generation += 1;
    this.clearTimer();
    this.nextDeadline = this.isHidden()
      ? null
      : this.now() + this.phaseIntervalMs();
    this.scheduleIfReady();
  };

  private phaseIntervalMs(): number {
    return 1_000 / (this.selectedRate * 2);
  }

  private canRun(generation: number): boolean {
    return (
      generation === this.generation &&
      this.requestedRunning &&
      !this.disposed &&
      !this.isHidden()
    );
  }

  private scheduleIfReady(): void {
    if (
      this.disposed ||
      !this.requestedRunning ||
      this.isHidden() ||
      this.executing ||
      this.timer !== null
    ) {
      return;
    }
    this.nextDeadline ??= this.now() + this.phaseIntervalMs();
    const generation = this.generation;
    const delay = Math.max(0, this.nextDeadline - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runScheduledPhases(generation);
    }, delay);
  }

  private async runScheduledPhases(generation: number): Promise<void> {
    if (!this.canRun(generation)) {
      return;
    }
    this.executing = true;
    try {
      let completed = 0;
      while (
        completed < MAX_CATCH_UP_PHASES &&
        this.canRun(generation)
      ) {
        await this.advancePhaseCommand();
        completed += 1;
        if (!this.canRun(generation)) {
          break;
        }
        this.nextDeadline =
          (this.nextDeadline ?? this.now()) + this.phaseIntervalMs();
        if (this.nextDeadline > this.now()) {
          break;
        }
      }
      if (
        this.canRun(generation) &&
        this.nextDeadline !== null &&
        this.nextDeadline <= this.now()
      ) {
        this.nextDeadline = this.now() + this.phaseIntervalMs();
      }
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.requestedRunning = false;
        this.invalidateSchedule();
        try {
          this.reportError(error);
        } catch {
          // Error reporting must not create an unhandled scheduler rejection.
        }
      }
    } finally {
      this.executing = false;
      this.scheduleIfReady();
    }
  }

  private invalidateSchedule(): void {
    this.generation += 1;
    this.nextDeadline = null;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer === null) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  private isHidden(): boolean {
    return this.visibilitySource?.visibilityState === "hidden";
  }
}

function assertRate(rate: number): asserts rate is AutoClockRate {
  if (!(AUTO_CLOCK_RATES as readonly number[]).includes(rate)) {
    throw new RangeError(`Unsupported automatic clock rate: ${rate}`);
  }
}
