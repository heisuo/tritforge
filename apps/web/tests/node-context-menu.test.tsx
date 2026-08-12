import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeContextMenu } from "../src/components/NodeContextMenu";

describe("NodeContextMenu", () => {
  afterEach(cleanup);

  it("runs rotation and delete commands", () => {
    const clockwise = vi.fn();
    const counterClockwise = vi.fn();
    const remove = vi.fn();
    render(
      <NodeContextMenu
        x={100}
        y={120}
        rotation={90}
        onRotateClockwise={clockwise}
        onRotateCounterClockwise={counterClockwise}
        onDelete={remove}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("当前方向 90°")).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "顺时针旋转" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "逆时针旋转" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除元件" }));

    expect(clockwise).toHaveBeenCalledTimes(1);
    expect(counterClockwise).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and outside pointer down", () => {
    const close = vi.fn();
    render(
      <NodeContextMenu
        x={100}
        y={120}
        rotation={0}
        onRotateClockwise={() => undefined}
        onRotateCounterClockwise={() => undefined}
        onDelete={() => undefined}
        onClose={close}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
