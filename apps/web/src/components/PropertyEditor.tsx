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
const MEMORY_TYPES = new Set(["memory.rom", "memory.ram"]);

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
  wordWidth: string;
  addressWidth: string;
  contents: string[];
}

function memoryDepth(addressWidth: number): number {
  return Number.isInteger(addressWidth) &&
    addressWidth >= 1 &&
    addressWidth <= 3
    ? 3 ** addressWidth
    : 0;
}

function balancedAddress(index: number, width: number): string {
  let value = index - (3 ** width - 1) / 2;
  const digits = Array<string>(width).fill("0");
  for (let position = width - 1; position >= 0; position -= 1) {
    const remainder = ((((value + 1) % 3) + 3) % 3) - 1;
    digits[position] = remainder === -1 ? "T" : String(remainder);
    value = (value - remainder) / 3;
  }
  return digits.join("");
}

function draftFrom(
  typeId: string,
  properties: Record<string, unknown>,
): DraftProperties {
  const valueKey = typeId === "project.module_input" ? "previewValue" : "value";
  return {
    width: String(properties.width ?? 1),
    tunnelLabel: String(properties.label ?? ""),
    branchCount: String(properties.branchCount ?? 1),
    mapping: Array.isArray(properties.mapping)
      ? properties.mapping.join(", ")
      : "",
    sourceWord: String(properties[valueKey] ?? "0"),
    wordWidth: String(properties.wordWidth ?? 3),
    addressWidth: String(properties.addressWidth ?? 3),
    contents: Array.isArray(properties.contents)
      ? properties.contents.map((word) => String(word))
      : [],
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

function resizeSplitterDraft(
  draft: DraftProperties,
  widthValue: string,
): DraftProperties {
  const width = Number(widthValue);
  const currentBranchCount = Number(draft.branchCount);
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    width > 27 ||
    !Number.isInteger(currentBranchCount) ||
    currentBranchCount < 1
  ) {
    return { ...draft, width: widthValue };
  }

  const branchCount = Math.min(currentBranchCount, width);
  const previous = draft.mapping
    .split(",")
    .map((entry) => Number(entry.trim()));
  const mapping = Array.from({ length: width }, (_, bit) => {
    const branch = previous[bit];
    return Number.isInteger(branch) && branch >= 0 && branch < branchCount
      ? branch
      : bit % branchCount;
  });

  const counts = Array<number>(branchCount).fill(0);
  mapping.forEach((branch) => {
    counts[branch] += 1;
  });
  for (let branch = 0; branch < branchCount; branch += 1) {
    if (counts[branch] > 0) continue;
    let replacement = -1;
    for (let bit = mapping.length - 1; bit >= 0; bit -= 1) {
      if (counts[mapping[bit]] > 1) {
        replacement = bit;
        break;
      }
    }
    if (replacement >= 0) {
      counts[mapping[replacement]] -= 1;
      mapping[replacement] = branch;
      counts[branch] += 1;
    }
  }

  return {
    ...draft,
    width: widthValue,
    branchCount: String(branchCount),
    mapping: mapping.join(", "),
  };
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
  const sourceProperties = useMemo(
    () => structuredClone(properties),
    [properties],
  );
  const [draft, setDraft] = useState(() => draftFrom(typeId, sourceProperties));
  const [error, setError] = useState<string | null>(null);
  const displayedWidth = Number(draft.width);
  const displayedBranchCount = Number(draft.branchCount);
  const displayedMapping = draft.mapping
    .split(",")
    .map((entry) => Number(entry.trim()));
  const mappingMenuCount =
    Number.isInteger(displayedWidth) &&
    displayedWidth >= 1 &&
    displayedWidth <= 27
      ? displayedWidth
      : 0;
  const mappingBranchCount =
    Number.isInteger(displayedBranchCount) &&
    displayedBranchCount >= 1 &&
    displayedBranchCount <= 27
      ? displayedBranchCount
      : 0;
  const displayedAddressWidth = Number(draft.addressWidth);
  const displayedMemoryDepth = memoryDepth(displayedAddressWidth);
  const displayedWordWidth = Number(draft.wordWidth);

  useEffect(() => {
    setDraft(draftFrom(typeId, sourceProperties));
    setError(null);
  }, [sourceProperties, typeId]);

  if (!WIDTH_TYPES.has(typeId) && !MEMORY_TYPES.has(typeId)) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const next = structuredClone(sourceProperties);
      if (MEMORY_TYPES.has(typeId)) {
        next.wordWidth = parseInteger(draft.wordWidth, "存储字宽");
        next.addressWidth = parseInteger(draft.addressWidth, "地址宽度");
        if (typeId === "memory.rom") {
          const depth = memoryDepth(next.addressWidth as number);
          const zeroWord = "0".repeat(next.wordWidth as number);
          next.contents = Array.from({ length: depth }, (_, index) =>
            String(draft.contents[index] ?? zeroWord)
              .trim()
              .toUpperCase(),
          );
        }
      } else {
        next.width = parseInteger(draft.width, "宽度");
      }
      if (typeId === "wiring.tunnel") next.label = draft.tunnelLabel.trim();
      if (typeId === "wiring.splitter") {
        next.branchCount = parseInteger(draft.branchCount, "分支数量");
        next.mapping = parseMapping(draft.mapping);
      }
      if (isSource(typeId)) {
        const key =
          typeId === "project.module_input" ? "previewValue" : "value";
        next[key] = draft.sourceWord.trim().toUpperCase();
      }
      const message = onCommit(next);
      setError(message ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section
      className="inspector-section property-editor"
      aria-labelledby="property-editor-title"
    >
      <div className="section-heading">
        <h2 id="property-editor-title">属性</h2>
        <span>
          {MEMORY_TYPES.has(typeId)
            ? `${draft.wordWidth}t × ${displayedMemoryDepth}`
            : `${draft.width}t`}
        </span>
      </div>
      <form onSubmit={submit}>
        {MEMORY_TYPES.has(typeId) ? (
          <>
            <label className="property-field">
              <span>存储字宽</span>
              <input
                aria-label="存储字宽"
                type="number"
                min="1"
                max="27"
                step="1"
                value={draft.wordWidth}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    wordWidth: event.target.value,
                  }))
                }
              />
            </label>
            <label className="property-field">
              <span>地址宽度</span>
              <select
                aria-label="地址宽度"
                value={draft.addressWidth}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    addressWidth: event.target.value,
                  }))
                }
              >
                <option value="1">1 trit / 3 字</option>
                <option value="2">2 trit / 9 字</option>
                <option value="3">3 trit / 27 字</option>
              </select>
            </label>
            {typeId === "memory.rom" && displayedMemoryDepth > 0 && (
              <div className="memory-contents-editor">
                <div className="memory-contents-heading">
                  <span>地址</span>
                  <strong>存储内容</strong>
                </div>
                <div className="memory-contents-grid">
                  {Array.from({ length: displayedMemoryDepth }, (_, index) => {
                    const address = balancedAddress(
                      index,
                      displayedAddressWidth,
                    );
                    const zeroWord =
                      Number.isInteger(displayedWordWidth) &&
                      displayedWordWidth > 0
                        ? "0".repeat(displayedWordWidth)
                        : "0";
                    return (
                      <label key={address}>
                        <span>{address}</span>
                        <input
                          aria-label={`ROM 地址 ${address}`}
                          type="text"
                          spellCheck="false"
                          value={draft.contents[index] ?? zeroWord}
                          onChange={(event) =>
                            setDraft((current) => {
                              const contents = [...current.contents];
                              contents[index] = event.target.value;
                              return { ...current, contents };
                            })
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
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
                  setDraft((current) =>
                    typeId === "wiring.splitter"
                      ? resizeSplitterDraft(current, event.target.value)
                      : { ...current, width: event.target.value },
                  )
                }
              />
            </label>
            <div
              className="width-presets"
              role="group"
              aria-label="常用信号宽度"
            >
              {WIDTH_PRESETS.map((width) => (
                <button
                  key={width}
                  type="button"
                  aria-label={`宽度 ${width} trit`}
                  className={draft.width === String(width) ? "is-active" : ""}
                  onClick={() =>
                    setDraft((current) =>
                      typeId === "wiring.splitter"
                        ? resizeSplitterDraft(current, String(width))
                        : { ...current, width: String(width) },
                    )
                  }
                >
                  {width}
                </button>
              ))}
            </div>
          </>
        )}

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
                      {Array.from(
                        { length: mappingBranchCount },
                        (_, branch) => (
                          <option key={branch} value={branch}>
                            {branch}
                          </option>
                        ),
                      )}
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

        {error && (
          <p className="property-error" role="alert">
            {error}
          </p>
        )}
        <button className="property-apply" type="submit" aria-label="应用属性">
          <Save aria-hidden="true" />
          应用
        </button>
      </form>
    </section>
  );
}
