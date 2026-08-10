import { describe, expect, it } from "vitest";
import { cloneExampleProject } from "../src/examples";

describe("3-trit parallel register example", () => {
  it("freezes the editable root circuit and structural Register module topology", () => {
    const project = cloneExampleProject("register3");
    expect(project).not.toBeNull();
    expect(project!.circuits.map((circuit) => circuit.id)).toEqual([
      "main",
      "register3",
    ]);

    const main = project!.circuits[0];
    expect(main.components.map((component) => [component.id, component.typeId])).toEqual([
      ["input-d2", "source.trit_input"],
      ["input-d1", "source.trit_input"],
      ["input-d0", "source.trit_input"],
      ["clock-1", "source.clock"],
      ["input-en", "source.trit_input"],
      ["input-rst", "source.trit_input"],
      ["register-1", "project.module_instance"],
      ["probe-q2", "sink.probe"],
      ["probe-q1", "sink.probe"],
      ["probe-q0", "sink.probe"],
    ]);
    expect(main.components.find((component) => component.id === "input-d2")?.properties.value).toBe("1");
    expect(main.components.find((component) => component.id === "input-d1")?.properties.value).toBe("T");
    expect(main.components.find((component) => component.id === "input-d0")?.properties.value).toBe("0");
    expect(main.components.find((component) => component.id === "input-en")?.properties.value).toBe("1");
    expect(main.components.find((component) => component.id === "input-rst")?.properties.value).toBe("0");
    expect(main.components.find((component) => component.id === "register-1")?.properties.moduleId).toBe("register3");
    expect(main.connections.map((wire) => [
      wire.sourceComponentId,
      wire.sourcePortId,
      wire.targetComponentId,
      wire.targetPortId,
    ])).toEqual([
      ["input-d2", "out", "register-1", "d2"],
      ["input-d1", "out", "register-1", "d1"],
      ["input-d0", "out", "register-1", "d0"],
      ["clock-1", "out", "register-1", "clk"],
      ["input-en", "out", "register-1", "en"],
      ["input-rst", "out", "register-1", "rst"],
      ["register-1", "q2", "probe-q2", "in"],
      ["register-1", "q1", "probe-q1", "in"],
      ["register-1", "q0", "probe-q0", "in"],
    ]);

    const register = project!.circuits[1];
    const boundaryPorts = register.components
      .filter((component) => component.typeId.startsWith("project.module_"))
      .map((component) => [component.typeId, component.properties.portId]);
    expect(boundaryPorts).toEqual([
      ["project.module_input", "d2"],
      ["project.module_input", "d1"],
      ["project.module_input", "d0"],
      ["project.module_input", "clk"],
      ["project.module_input", "en"],
      ["project.module_input", "rst"],
      ["project.module_output", "q2"],
      ["project.module_output", "q1"],
      ["project.module_output", "q0"],
    ]);
    expect(
      register.components
        .filter((component) =>
          ["wiring.splitter", "sequential.register"].includes(component.typeId),
        )
        .map((component) => [component.id, component.typeId]),
    ).toEqual([
      ["data-splitter", "wiring.splitter"],
      ["register-word", "sequential.register"],
      ["output-splitter", "wiring.splitter"],
    ]);
    expect(
      register.components.find((component) => component.id === "register-word")
        ?.properties,
    ).toMatchObject({ label: "Register[3]", width: 3 });
    for (const splitterId of ["data-splitter", "output-splitter"]) {
      expect(
        register.components.find((component) => component.id === splitterId)
          ?.properties,
      ).toMatchObject({ width: 3, branchCount: 3, mapping: [0, 1, 2] });
    }
    expect(
      register.connections.map((wire) => [
        wire.sourceComponentId,
        wire.sourcePortId,
        wire.targetComponentId,
        wire.targetPortId,
      ]),
    ).toEqual([
      ["input-d2", "out", "data-splitter", "branch2"],
      ["input-d1", "out", "data-splitter", "branch1"],
      ["input-d0", "out", "data-splitter", "branch0"],
      ["data-splitter", "trunk", "register-word", "d"],
      ["input-clk", "out", "register-word", "clk"],
      ["input-en", "out", "register-word", "en"],
      ["input-rst", "out", "register-word", "rst"],
      ["register-word", "q", "output-splitter", "trunk"],
      ["output-splitter", "branch2", "output-q2", "in"],
      ["output-splitter", "branch1", "output-q1", "in"],
      ["output-splitter", "branch0", "output-q0", "in"],
    ]);
  });
});
