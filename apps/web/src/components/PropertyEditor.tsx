import { Save } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

const WIDTH_PRESETS = [1, 3, 6, 9, 18, 27] as const;
const WIDTH_TYPES = new Set([
  "source.trit_input",
  "source.constant",
  "sink.probe",
  "project.module_input",
  "project.module_output",
  "wiring.junction",
  "wiring.tunnel",
  "wiring.splitter",
]);

interface PropertyEditorProps {
  typeId: string;
  properties: Record<string, unknown>;
  onCommit: (properties: Record<string, unknown>) => string | undefined;
}

interface DraftProperties {
  width: string;
  tunnelLabel: string;
  branchCount: string;
  mapping: string;
  sourceWord: string;
}

function draftFrom(typeId: string, properties: Record<string, unknown>): DraftProperties {
  const valueKey = typeId === "project.module_input" ? "previewValue" : "value";
  return {
    width: String(properties.width ?? 1),
    tunnelLabel: String(properties.label ?? ""),
    branchCount: String(properties.branchCount ?? 1),
    mapping: Array.isArray(properties.mapping)
      ? properties.mapping.join(", ")
      : "",
    sourceWord: String(properties[valueKey] ?? "0"),
  };
}

function parseInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label}必须是整数`);
  return parsed;
}

function parseMapping(value: string): number[] {
  if (!/^\s*\d+(?:\s*,\s*\d+)*\s*$/.test(value)) {
    throw new Error("位映射必须是整数列表");
  }
  return value.split(",").map((entry) => Number(entry.trim()));
}

function isSource(typeId: string): boolean {
  return (
    typeId === "source.trit_input" ||
    typeId === "source.constant" ||
    typeId === "project.module_input"
  );
}

export function PropertyEditor({
  typeId,
  properties,
  onCommit,
}: PropertyEditorProps) {
  const sourceProperties = useMemo(() => structuredClone(properties), [properties]);
  const [draft, setDraft] = useState(() => draftFrom(typeId, sourceProperties));
  const [error, setError] = useState<string | null>(null);
  const displayedWidth = Number(draft.width);
  const displayedBranchCount = Number(draft.branchCount);
  const displayedMapping = draft.mapping
    .split(",")
    .map((entry) => Number(entry.trim()));
  const mappingMenuCount =
    Number.isInteger(displayedWidth) && displayedWidth >= 1 && displayedWidth <= 27
      ? displayedWidth
      : 0;
  const mappingBranchCount =
    Number.isInteger(displayedBranchCount) &&
    displayedBranchCount >= 1 &&
    displayedBranchCount <= 27
      ? displayedBranchCount
      : 0;

  useEffect(() => {
    setDraft(draftFrom(typeId, sourceProperties));
    setError(null);
  }, [sourceProperties, typeId]);

  if (!WIDTH_TYPES.has(typeId)) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const next = structuredClone(sourceProperties);
      next.width = parseInteger(draft.width, "宽度");
      if (typeId === "wiring.tunnel") next.label = draft.tunnelLabel.trim();
      if (typeId === "wiring.splitter") {
        next.branchCount = parseInteger(draft.branchCount, "分支数量");
        next.mapping = parseMapping(draft.mapping);
      }
      if (isSource(typeId)) {
        const key = typeId === "project.module_input" ? "previewValue" : "value";
        next[key] = draft.sourceWord.trim().toUpperCase();
      }
      const message = onCommit(next);
      setError(message ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="inspector-section property-editor" aria-labelledby="property-editor-title">
      <div className="section-heading">
        <h2 id="property-editor-title">属性</h2>
        <span>{draft.width}t</span>
      </div>
      <form onSubmit={submit}>
        <label className="property-field">
          <span>信号宽度</span>
          <input
            aria-label="信号宽度"
            type="number"
            min="1"
            max="27"
            step="1"
            value={draft.width}
            onChange={(event) =>
              setDraft((current) => ({ ...current, width: event.target.value }))
            }
          />
        </label>
        <div className="width-presets" role="group" aria-label="常用信号宽度">
          {WIDTH_PRESETS.map((width) => (
            <button
              key={width}
              type="button"
              aria-label={`宽度 ${width} trit`}
              className={draft.width === String(width) ? "is-active" : ""}
              onClick={() =>
                setDraft((current) => ({ ...current, width: String(width) }))
              }
            >
              {width}
            </button>
          ))}
        </div>

        {typeId === "wiring.tunnel" && (
          <label className="property-field">
            <span>网络名称</span>
            <input
              aria-label="隧道名称"
              type="text"
              value={draft.tunnelLabel}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  tunnelLabel: event.target.value,
                }))
              }
            />
          </label>
        )}

        {typeId === "wiring.splitter" && (
          <>
            <label className="property-field">
              <span>分支数量</span>
              <input
                aria-label="分支数量"
                type="number"
                min="1"
                max="27"
                step="1"
                value={draft.branchCount}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    branchCount: event.target.value,
                  }))
                }
              />
            </label>
            <label className="property-field">
              <span>位映射</span>
              <input
                aria-label="位映射"
                type="text"
                inputMode="numeric"
                value={draft.mapping}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    mapping: event.target.value,
                  }))
                }
              />
            </label>
            {mappingMenuCount > 0 && mappingBranchCount > 0 && (
              <div
                className="splitter-mapping-grid"
                role="group"
                aria-label="逐位分支映射"
              >
                {Array.from({ length: mappingMenuCount }, (_, bit) => (
                  <label key={bit}>
                    <span>b{bit}</span>
                    <select
                      aria-label={`主干位 ${bit} 分支`}
                      value={
                        Number.isInteger(displayedMapping[bit])
                          ? displayedMapping[bit]
                          : ""
                      }
                      onChange={(event) => {
                        const next = Array.from(
                          { length: mappingMenuCount },
                          (_, index) =>
                            Number.isInteger(displayedMapping[index])
                              ? displayedMapping[index]
                              : 0,
                        );
                        next[bit] = Number(event.target.value);
                        setDraft((current) => ({
                          ...current,
                          mapping: next.join(", "),
                        }));
                      }}
                    >
                      {!Number.isInteger(displayedMapping[bit]) && (
                        <option value="">-</option>
                      )}
                      {Array.from({ length: mappingBranchCount }, (_, branch) => (
                        <option key={branch} value={branch}>
                          {branch}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
          </>
        )}

        {isSource(typeId) && (
          <label className="property-field">
            <span>源字值</span>
            <input
              aria-label="源字值"
              type="text"
              spellCheck="false"
              value={draft.sourceWord}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  sourceWord: event.target.value,
                }))
              }
            />
          </label>
        )}

        {error && <p className="property-error" role="alert">{error}</p>}
        <button className="property-apply" type="submit" aria-label="应用属性">
          <Save aria-hidden="true" />
          应用
        </button>
      </form>
    </section>
  );
}
