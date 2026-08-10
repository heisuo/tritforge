import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PropertyEditor } from "../src/components/PropertyEditor";

describe("PropertyEditor", () => {
  afterEach(cleanup);

  it("commits a width preset and source word together as one property update", () => {
    const onCommit = vi.fn(() => undefined);
    render(
      <PropertyEditor
        typeId="source.trit_input"
        properties={{ width: 1, value: "0", label: "Input" }}
        onCommit={onCommit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "宽度 3 trit" }));
    fireEvent.change(screen.getByLabelText("源字值"), {
      target: { value: "1T0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用属性" }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({
      width: 3,
      value: "1T0",
      label: "Input",
    });
  });

  it("edits splitter width, branch count, and mapping in one transaction", () => {
    const onCommit = vi.fn(() => undefined);
    render(
      <PropertyEditor
        typeId="wiring.splitter"
        properties={{ width: 3, branchCount: 3, mapping: [0, 1, 2] }}
        onCommit={onCommit}
      />,
    );

    fireEvent.change(screen.getByLabelText("分支数量"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("位映射"), {
      target: { value: "0, 1, 1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用属性" }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({
      width: 3,
      branchCount: 2,
      mapping: [0, 1, 1],
    });
  });

  it("offers one branch menu for every displayed trunk bit", () => {
    const onCommit = vi.fn(() => undefined);
    render(
      <PropertyEditor
        typeId="wiring.splitter"
        properties={{ width: 3, branchCount: 3, mapping: [0, 1, 2] }}
        onCommit={onCommit}
      />,
    );

    fireEvent.change(screen.getByLabelText("主干位 0 分支"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用属性" }));

    expect(onCommit).toHaveBeenCalledWith({
      width: 3,
      branchCount: 3,
      mapping: [1, 1, 2],
    });
  });

  it("keeps drafts visible and reports a stable Chinese validation error", () => {
    const onCommit = vi.fn(() => "位映射无效 [INVALID_SPLITTER_MAP]");
    render(
      <PropertyEditor
        typeId="wiring.splitter"
        properties={{ width: 3, branchCount: 3, mapping: [0, 1, 2] }}
        onCommit={onCommit}
      />,
    );

    fireEvent.change(screen.getByLabelText("位映射"), {
      target: { value: "0, 0, 0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用属性" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "位映射无效 [INVALID_SPLITTER_MAP]",
    );
    expect(screen.getByLabelText("位映射")).toHaveValue("0, 0, 0");
  });

  it("does not submit malformed local mapping syntax", () => {
    const onCommit = vi.fn(() => undefined);
    render(
      <PropertyEditor
        typeId="wiring.splitter"
        properties={{ width: 3, branchCount: 3, mapping: [0, 1, 2] }}
        onCommit={onCommit}
      />,
    );

    fireEvent.change(screen.getByLabelText("位映射"), {
      target: { value: "0, x, 1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用属性" }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("位映射必须是整数列表");
  });
});
