import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Eraser,
  Gauge,
  Pause,
  Play,
  Plus,
  SkipForward,
  StepForward,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  AUTO_CLOCK_RATES,
  type AutoClockRate,
  type AutoClockStatus,
} from "../app/auto-clock";
import type {
  TraceFrame,
  TraceSignalRef,
  TraceWatch,
} from "../wasm-client";

const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 480;
const HEIGHT_STEP = 24;
const FRAME_WIDTH = 42;
const MAX_WATCHES = 64;

export type BusDisplayMode = "balanced" | "decimal" | "trits";

export interface ChronogramSignalOption {
  id: string;
  label: string;
  width: number;
  signal: TraceSignalRef;
}

export interface ChronogramProps {
  availableSignals: ChronogramSignalOption[];
  watches: TraceWatch[];
  frames: TraceFrame[];
  rate: AutoClockRate;
  status: AutoClockStatus;
  disabled?: boolean;
  onToggleRun: () => void | Promise<void>;
  onAdvancePhase: () => void | Promise<void>;
  onTick: () => void | Promise<void>;
  onClear: () => void | Promise<void>;
  onRateChange: (rate: AutoClockRate) => void | Promise<void>;
  onWatchesChange: (watches: TraceWatch[]) => void | Promise<void>;
}

export function Chronogram({
  availableSignals,
  watches,
  frames,
  rate,
  status,
  disabled = false,
  onToggleRun,
  onAdvancePhase,
  onTick,
  onClear,
  onRateChange,
  onWatchesChange,
}: ChronogramProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [displayMode, setDisplayMode] = useState<BusDisplayMode>("balanced");
  const [selectedSignalId, setSelectedSignalId] = useState("");
  const [cursor, setCursor] = useState(Math.max(0, frames.length - 1));
  const [busy, setBusy] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const optionById = useMemo(
    () => new Map(availableSignals.map((option) => [option.id, option])),
    [availableSignals],
  );
  const watchedIds = useMemo(
    () => new Set(watches.map((watch) => watch.id)),
    [watches],
  );
  const addableSignals = useMemo(
    () => availableSignals.filter((option) => !watchedIds.has(option.id)),
    [availableSignals, watchedIds],
  );
  const selectedFrame = frames[cursor] ?? frames.at(-1);
  const selectedValues = useMemo(
    () => new Map(selectedFrame?.values.map((value) => [value.watchId, value.value])),
    [selectedFrame],
  );

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, frames.length - 1)));
  }, [frames.length]);

  useEffect(() => {
    if (selectedSignalId && addableSignals.some((item) => item.id === selectedSignalId)) {
      return;
    }
    setSelectedSignalId(addableSignals[0]?.id ?? "");
  }, [addableSignals, selectedSignalId]);

  useEffect(() => {
    const onPointerMove = (event: globalThis.PointerEvent) => {
      if (!dragRef.current) return;
      setHeight(
        clampHeight(
          dragRef.current.startHeight + dragRef.current.startY - event.clientY,
        ),
      );
    };
    const onPointerUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  const runAction = (action: () => void | Promise<void>): void | Promise<void> => {
    if (disabled || busy) return;
    setBusy(true);
    try {
      const result = action();
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).finally(() => setBusy(false));
      }
      setBusy(false);
    } catch (error) {
      setBusy(false);
      throw error;
    }
  };

  const replaceWatches = (next: TraceWatch[]) =>
    runAction(() => onWatchesChange(next));

  const addWatch = () => {
    const option = optionById.get(selectedSignalId);
    if (!option || watches.length >= MAX_WATCHES || watchedIds.has(option.id)) return;
    void replaceWatches([
      ...watches,
      { id: option.id, signal: structuredClone(option.signal) },
    ]);
  };

  const moveWatch = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= watches.length) return;
    const next = [...watches];
    [next[index], next[target]] = [next[target], next[index]];
    void replaceWatches(next);
  };

  const resizeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const offset = event.key === "ArrowUp" ? HEIGHT_STEP : -HEIGHT_STEP;
    setHeight((current) => clampHeight(current + offset));
  };

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    dragRef.current = { startY: event.clientY, startHeight: height };
  };

  const controlsDisabled = disabled || busy || status === "disposed";
  const running = status === "running" || status === "suspended";

  return (
    <section
      className={`chronogram ${collapsed ? "is-collapsed" : ""}`}
      style={{ height: collapsed ? "36px" : `${height}px` }}
      role="region"
      aria-label="时序图"
    >
      <div
        className="chronogram-resizer"
        role="separator"
        aria-label="调整时序图高度"
        aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={MAX_HEIGHT}
        aria-valuenow={height}
        tabIndex={collapsed ? -1 : 0}
        onPointerDown={startResize}
        onKeyDown={resizeFromKeyboard}
      />
      <header className="chronogram-toolbar">
        <div className="chronogram-title">
          <Gauge aria-hidden="true" />
          <strong>时序图</strong>
          <span>{frames.length}/512</span>
        </div>
        <div className="chronogram-actions" role="toolbar" aria-label="时序控制">
          <button
            type="button"
            className="icon-button"
            title={running ? "暂停自动时钟" : "运行自动时钟"}
            aria-label={running ? "暂停自动时钟" : "运行自动时钟"}
            disabled={controlsDisabled}
            onClick={() => void runAction(onToggleRun)}
          >
            {running ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="icon-button"
            title="推进一个相位"
            aria-label="推进一个相位"
            disabled={controlsDisabled || running}
            onClick={() => void runAction(onAdvancePhase)}
          >
            <StepForward aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="推进一个完整 Tick"
            aria-label="推进一个完整 Tick"
            disabled={controlsDisabled || running}
            onClick={() => void runAction(onTick)}
          >
            <SkipForward aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="清空时序记录"
            aria-label="清空时序记录"
            disabled={controlsDisabled || frames.length === 0}
            onClick={() => void runAction(onClear)}
          >
            <Eraser aria-hidden="true" />
          </button>
          <label className="chronogram-select">
            <span className="visually-hidden">自动时钟速度</span>
            <select
              aria-label="自动时钟速度"
              value={rate}
              disabled={controlsDisabled}
              onChange={(event) =>
                void runAction(() =>
                  onRateChange(Number(event.target.value) as AutoClockRate),
                )
              }
            >
              {AUTO_CLOCK_RATES.map((item) => (
                <option key={item} value={item}>
                  {item} cyc/s
                </option>
              ))}
            </select>
          </label>
          <label className="chronogram-select">
            <span className="visually-hidden">总线显示模式</span>
            <select
              aria-label="总线显示模式"
              value={displayMode}
              onChange={(event) => setDisplayMode(event.target.value as BusDisplayMode)}
            >
              <option value="balanced">平衡三进制</option>
              <option value="decimal">十进制</option>
              <option value="trits">逐 trit</option>
            </select>
          </label>
          <button
            type="button"
            className="icon-button chronogram-collapse"
            title={collapsed ? "展开时序图" : "折叠时序图"}
            aria-label={collapsed ? "展开时序图" : "折叠时序图"}
            onClick={() => setCollapsed((current) => !current)}
          >
            {collapsed ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </button>
        </div>
      </header>

      {!collapsed && (
        <div className="chronogram-body">
          <aside className="chronogram-watch-panel" aria-label="观察信号">
            <div className="chronogram-add-watch">
              <label>
                <span className="visually-hidden">可观察信号</span>
                <select
                  aria-label="可观察信号"
                  value={selectedSignalId}
                  disabled={controlsDisabled || addableSignals.length === 0}
                  onChange={(event) => setSelectedSignalId(event.target.value)}
                >
                  {addableSignals.length === 0 && <option value="">无可添加信号</option>}
                  {addableSignals.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label} [{option.width}t]
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="icon-button"
                title="添加观察信号"
                aria-label="添加观察信号"
                disabled={
                  controlsDisabled ||
                  !selectedSignalId ||
                  watches.length >= MAX_WATCHES
                }
                onClick={addWatch}
              >
                <Plus aria-hidden="true" />
              </button>
            </div>
            <ol className="chronogram-watch-list">
              {watches.map((watch, index) => {
                const option = optionById.get(watch.id);
                const label = option?.label ?? watch.id;
                return (
                  <li
                    key={watch.id}
                    data-testid="chronogram-watch"
                    data-watch-id={watch.id}
                    className="chronogram-watch"
                  >
                    <span data-testid="watch-label" title={label}>
                      {label}
                    </span>
                    <code>{selectedValues.get(watch.id) ?? "-"}</code>
                    <button
                      type="button"
                      title={`上移 ${label}`}
                      aria-label={`上移 ${label}`}
                      disabled={controlsDisabled || index === 0}
                      onClick={() => moveWatch(index, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      title={`下移 ${label}`}
                      aria-label={`下移 ${label}`}
                      disabled={controlsDisabled || index === watches.length - 1}
                      onClick={() => moveWatch(index, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      title={`移除 ${label}`}
                      aria-label={`移除 ${label}`}
                      disabled={controlsDisabled}
                      onClick={() =>
                        void replaceWatches(watches.filter((item) => item.id !== watch.id))
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ol>
          </aside>

          <div className="chronogram-main">
            <div
              className="chronogram-viewport"
              data-testid="chronogram-viewport"
              data-frame-count={frames.length}
            >
              <div
                className="chronogram-track"
                style={{ width: `${Math.max(1, frames.length) * FRAME_WIDTH}px` }}
              >
                <div className="chronogram-ruler" aria-hidden="true">
                  {frames.map((item, index) => (
                    <span
                      key={`${item.cycle}-${item.clockPhase}-${index}`}
                      className={`reason-${item.reason}`}
                      style={{ width: `${FRAME_WIDTH}px` }}
                    >
                      {item.cycle}.{item.clockPhase === "highStable" ? "H" : "L"}
                    </span>
                  ))}
                </div>
                {watches.map((watch) => {
                  const option = optionById.get(watch.id);
                  const width = option?.width ?? inferredWidth(frames, watch.id);
                  return (
                    <div
                      key={watch.id}
                      className="chronogram-wave-row"
                      data-testid={`wave-${watch.id}`}
                    >
                      {width === 1 ? (
                        <ScalarWave frames={frames} watchId={watch.id} />
                      ) : (
                        <BusWave
                          frames={frames}
                          watchId={watch.id}
                          displayMode={displayMode}
                        />
                      )}
                    </div>
                  );
                })}
                {frames.length > 0 && (
                  <span
                    className="chronogram-cursor-line"
                    aria-hidden="true"
                    style={{ left: `${cursor * FRAME_WIDTH + FRAME_WIDTH / 2}px` }}
                  />
                )}
              </div>
            </div>
            <input
              className="chronogram-cursor"
              type="range"
              min={0}
              max={Math.max(0, frames.length - 1)}
              value={Math.min(cursor, Math.max(0, frames.length - 1))}
              disabled={frames.length === 0}
              aria-label="时序图游标"
              onChange={(event) => setCursor(Number(event.target.value))}
            />
            <output className="chronogram-cursor-values" data-testid="chronogram-cursor-values">
              {selectedFrame ? (
                <>
                  <strong>周期 {selectedFrame.cycle}</strong>
                  <span>{selectedFrame.clockPhase === "highStable" ? "HIGH" : "LOW"}</span>
                  {watches.map((watch) => (
                    <span key={watch.id}>
                      {optionById.get(watch.id)?.label ?? watch.id}{" "}
                      {formatWord(selectedValues.get(watch.id) ?? "-", displayMode)}
                    </span>
                  ))}
                </>
              ) : (
                <span>0 帧</span>
              )}
            </output>
          </div>
        </div>
      )}
    </section>
  );
}

function ScalarWave({ frames, watchId }: { frames: TraceFrame[]; watchId: string }) {
  return (
    <div className="scalar-waveform" data-testid="scalar-waveform">
      <span className="scalar-guide guide-high" />
      <span className="scalar-guide guide-middle" />
      <span className="scalar-guide guide-low" />
      {frames.map((frame, index) => {
        const symbol = valueFor(frame, watchId);
        const level = symbol === "T" ? "low" : symbol === "0" ? "middle" : "high";
        const known = symbol === "T" || symbol === "0" || symbol === "1";
        return (
          <span
            key={`${frame.cycle}-${frame.clockPhase}-${index}`}
            className={
              known
                ? `scalar-segment level-${level}`
                : `scalar-segment scalar-meta state-${symbol}`
            }
            data-testid={`scalar-${symbol}`}
            data-level={known ? level : undefined}
            style={{ left: `${index * FRAME_WIDTH}px`, width: `${FRAME_WIDTH}px` }}
          >
            {!known ? symbol : null}
          </span>
        );
      })}
    </div>
  );
}

function BusWave({
  frames,
  watchId,
  displayMode,
}: {
  frames: TraceFrame[];
  watchId: string;
  displayMode: BusDisplayMode;
}) {
  return (
    <div className="bus-waveform">
      {frames.map((frame, index) => {
        const word = valueFor(frame, watchId);
        const meta = /[XZE]/.exec(word)?.[0];
        return (
          <span
            key={`${frame.cycle}-${frame.clockPhase}-${index}`}
            className={`bus-segment ${meta ? `state-${meta}` : "state-known"}`}
            style={{ left: `${index * FRAME_WIDTH}px`, width: `${FRAME_WIDTH}px` }}
            title={word}
          >
            {formatWord(word, displayMode)}
          </span>
        );
      })}
    </div>
  );
}

function valueFor(frame: TraceFrame, watchId: string): string {
  return frame.values.find((value) => value.watchId === watchId)?.value ?? "X";
}

function inferredWidth(frames: TraceFrame[], watchId: string): number {
  return frames.find((frame) => frame.values.some((value) => value.watchId === watchId))
    ?.values.find((value) => value.watchId === watchId)?.value.length ?? 1;
}

function formatWord(word: string, mode: BusDisplayMode): string {
  if (mode === "trits") return [...word].join(" ");
  if (mode === "decimal" && /^[T01]+$/.test(word)) {
    let value = 0n;
    for (const trit of word) {
      value = value * 3n + (trit === "T" ? -1n : trit === "1" ? 1n : 0n);
    }
    return value.toString();
  }
  return word;
}

function clampHeight(value: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(value)));
}
