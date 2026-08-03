import { ArrowLeft, ChevronRight } from "lucide-react";

export interface HierarchyBreadcrumbEntry {
  circuitId: string;
  name: string;
}

export interface HierarchyBreadcrumbsProps {
  entries: HierarchyBreadcrumbEntry[];
  onNavigate: (index: number) => void;
}

export function HierarchyBreadcrumbs({
  entries,
  onNavigate,
}: HierarchyBreadcrumbsProps) {
  const currentIndex = entries.length - 1;

  return (
    <nav className="hierarchy-breadcrumbs" aria-label="层级导航">
      {entries.length > 1 && (
        <button
          type="button"
          aria-label="返回上级"
          title="返回上级"
          onClick={() => onNavigate(entries.length - 2)}
        >
          <ArrowLeft aria-hidden="true" />
        </button>
      )}

      <ol>
        {entries.map((entry, index) => {
          const isCurrent = index === currentIndex;
          return (
            <li key={`${entry.circuitId}-${index}`}>
              {index > 0 && <ChevronRight aria-hidden="true" />}
              <button
                type="button"
                aria-current={isCurrent ? "page" : undefined}
                disabled={isCurrent}
                onClick={() => onNavigate(index)}
              >
                {entry.name}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
