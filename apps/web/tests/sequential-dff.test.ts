import { describe, expect, it } from "vitest";
import { COMPONENT_HELP } from "../src/component-help";
import { cloneExampleProject } from "../src/examples";

describe("sequential DFF example", () => {
  it("keeps the exact editable topology and defaults", () => {
    const project = cloneExampleProject("sequential-dff")!;
    const main = project.circuits.find((circuit) => circuit.id === "main")!;

    expect(main.components.map((component) => component.typeId)).toEqual([
      "source.trit_input",
      "source.clock",
      "source.trit_input",
      "source.trit_input",
      "sequential.dff",
      "sink.probe",
    ]);
    expect(main.components[0].properties.value).toBe("1");
    expect(main.components[2].properties.value).toBe("1");
    expect(main.components[3].properties.value).toBe("0");
    expect(main.components[4].properties).not.toHaveProperty("value");
    expect(main.connections.map((connection) => [
      connection.sourceComponentId,
      connection.sourcePortId,
      connection.targetComponentId,
      connection.targetPortId,
    ])).toEqual([
      ["input-d", "out", "dff-1", "d"],
      ["clock-1", "out", "dff-1", "clk"],
      ["input-en", "out", "dff-1", "en"],
      ["input-rst", "out", "dff-1", "rst"],
      ["dff-1", "q", "probe-q", "in"],
    ]);
  });

  it("documents positive edge, synchronous reset priority, and one-click full tick", () => {
    expect(COMPONENT_HELP["sequential.dff"].details).toMatch(/正沿|上升沿/);
    expect(COMPONENT_HELP["sequential.dff"].details).toMatch(/同步.*复位|复位.*优先/);
    expect(COMPONENT_HELP["sequential.dff"].details).toMatch(/一次点击.*tick|完整.*tick/i);
  });
});
