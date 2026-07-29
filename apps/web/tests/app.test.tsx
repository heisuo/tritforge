import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";

describe("App", () => {
  it("opens directly into the editor shell", () => {
    render(<App />);
    expect(screen.getByRole("main", { name: "Logsim Ternary 编辑器" }))
      .toBeInTheDocument();
  });
});
