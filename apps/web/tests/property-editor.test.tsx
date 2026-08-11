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

  it("extends a splitter mapping when its width preset grows", () => {
    const onCommit = vi.fn(() => undefined);
    render(
      <PropertyEditor
        typeId="wiring.splitter"
        properties={{ width: 3, branchCount: 3, mapping: [0, 1, 2] }}
        onCommit={onCommit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "宽度 6 trit" }));
    fireEvent.click(screen.getByRole("button", { name: "应用属性" }));

    expect(onCommit).toHaveBeenCalledWith({
      width: 6,
      branchCount: 3,
      mapping: [0, 1, 2, 0, 1, 2],
    });
  });

  it("shrinks the splitter branch count with its width", () => {
    const onCommit = vi.fn(() => undefined);
    render(
      <PropertyEditor
        typeId="wiring.splitter"
        properties={{ width: 3, branchCount: 3, mapping: [0, 1, 2] }}
        onCommit={onCommit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "宽度 1 trit" }));
    fireEvent.click(screen.getByRole("button", { name: "应用属性" }));

    expect(onCommit).toHaveBeenCalledWith({
      width: 1,
      branchCount: 1,
      mapping: [0],
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

  it("edits ROM geometry and its address-labelled contents atomically", () => {
    const onCommit = vi.fn(() => undefined);
    render(
      <PropertyEditor
        typeId="memory.rom"
        properties={{
          label: "Program ROM",
          wordWidth: 3,
          addressWidth: 3,
          contents: Array(27).fill("000"),
        }}
        onCommit={onCommit}
      />,
    );

    expect(screen.getByLabelText("ROM 地址 T00")).toHaveValue("000");
    expect(screen.getByLabelText("ROM 地址 000")).toHaveValue("000");
    expect(screen.getByLabelText("ROM 地址 100")).toHaveValue("000");
    fireEvent.change(screen.getByLabelText("ROM 地址 T00"), {
      target: { value: "1t0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用属性" }));

    const expected = Array(27).fill("000");
    expected[4] = "1T0";
    expect(onCommit).toHaveBeenCalledWith({
      label: "Program ROM",
      wordWidth: 3,
      addressWidth: 3,
      contents: expected,
    });
  });

  it("configures RAM geometry without exposing ROM contents", () => {
    const onCommit = vi.fn(() => undefined);
    render(
      <PropertyEditor
        typeId="memory.ram"
        properties={{ label: "Data RAM", wordWidth: 3, addressWidth: 2 }}
        onCommit={onCommit}
      />,
    );

    expect(screen.queryByText("存储内容")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("存储字宽"), {
      target: { value: "6" },
    });
    fireEvent.change(screen.getByLabelText("地址宽度"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用属性" }));

    expect(onCommit).toHaveBeenCalledWith({
      label: "Data RAM",
      wordWidth: 6,
      addressWidth: 1,
    });
  });
});
