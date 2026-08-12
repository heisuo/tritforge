import { RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import type { NodeRotation } from "../editor/node-rotation";

const MENU_WIDTH = 190;
const MENU_HEIGHT = 154;
const VIEWPORT_GAP = 8;

interface NodeContextMenuProps {
  x: number;
  y: number;
  rotation: NodeRotation;
  onRotateClockwise: () => void;
  onRotateCounterClockwise: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function NodeContextMenu({
  x,
  y,
  rotation,
  onRotateClockwise,
  onRotateCounterClockwise,
  onDelete,
  onClose,
}: NodeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const left = Math.max(
    VIEWPORT_GAP,
    Math.min(x, window.innerWidth - MENU_WIDTH - VIEWPORT_GAP),
  );
  const top = Math.max(
    VIEWPORT_GAP,
    Math.min(y, window.innerHeight - MENU_HEIGHT - VIEWPORT_GAP),
  );

  useEffect(() => {
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as globalThis.Node)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="node-context-menu"
      role="menu"
      aria-label="元件菜单"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="node-context-heading">当前方向 {rotation}°</div>
      <button type="button" role="menuitem" onClick={onRotateClockwise}>
        <RotateCw aria-hidden="true" />
        顺时针旋转
      </button>
      <button type="button" role="menuitem" onClick={onRotateCounterClockwise}>
        <RotateCcw aria-hidden="true" />
        逆时针旋转
      </button>
      <button
        type="button"
        role="menuitem"
        className="is-danger"
        onClick={onDelete}
      >
        <Trash2 aria-hidden="true" />
        删除元件
      </button>
    </div>
  );
}
