import { ArrowRight, CircuitBoard, X } from "lucide-react";
import { useEffect } from "react";
import type { ExampleId, TernaryExample } from "./examples";

export function ExampleLibrary({
  examples,
  onLoad,
  onClose,
}: {
  examples: TernaryExample[];
  onLoad: (id: ExampleId) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="example-library-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        aria-labelledby="example-library-title"
        aria-modal="true"
        className="example-library-dialog"
        role="dialog"
      >
        <header className="example-library-header">
          <div>
            <CircuitBoard aria-hidden="true" />
            <div>
              <h2 id="example-library-title">三进制示例库</h2>
              <p>选择一个完整电路载入画布，之后仍可自由编辑。</p>
            </div>
          </div>
          <button
            aria-label="关闭示例库"
            className="example-library-close"
            onClick={onClose}
            title="关闭示例库"
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="example-library-list">
          {examples.map((example, index) => (
            <article className="example-library-item" key={example.id}>
              <div className="example-number">
                {String(index + 1).padStart(2, "0")}
              </div>
              <div className="example-library-copy">
                <span>{example.category}</span>
                <h3>{example.name}</h3>
                <p>{example.description}</p>
                <code>{example.composition}</code>
                <strong>{example.expected}</strong>
              </div>
              <button
                aria-label={`载入示例：${example.name}`}
                onClick={() => onLoad(example.id)}
                type="button"
              >
                载入
                <ArrowRight aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

