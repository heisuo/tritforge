import { describe, expect, it } from "vitest";
import { createProjectStore } from "../src/project/project-store";
import type { ProjectDocumentV2 } from "../src/project/project-document";

function emptyProject(): ProjectDocumentV2 {
  return {
    format: "logsim-ternary",
    version: 2,
    rootCircuitId: "main",
    circuits: [
      {
        id: "main",
        name: "Main",
        kind: "main",
        components: [],
        connections: [],
      },
    ],
  };
}

function instance(id: string, moduleId: string) {
  return {
    id,
    typeId: "project.module_instance",
    position: { x: 0, y: 0 },
    properties: { moduleId, label: id },
  };
}

describe("project store", () => {
  it("allocates collision-free module IDs and enters shared definitions", () => {
    const store = createProjectStore(emptyProject());

    expect(store.getState().createModule("Half Adder")).toBe("half-adder-1");
    expect(store.getState().createModule("Half Adder")).toBe("half-adder-2");
    store.getState().addComponent(
      "main",
      instance("ha-instance-1", "half-adder-1"),
    );
    store.getState().enterInstance("main", "ha-instance-1");

    expect(store.getState().activePath.map((entry) => entry.circuitId)).toEqual([
      "main",
      "half-adder-1",
    ]);
  });

  it("protects referenced modules and connected boundary ports from deletion", () => {
    const store = createProjectStore(emptyProject());
    const moduleId = store.getState().createModule("Identity");
    store.getState().addComponent(moduleId, {
      id: "input",
      typeId: "project.module_input",
      position: { x: 0, y: 0 },
      properties: { portId: "a", label: "A", previewValue: "0" },
    });
    store.getState().addComponent(moduleId, {
      id: "buffer",
      typeId: "gate.buf",
      position: { x: 200, y: 0 },
      properties: {},
    });
    store.getState().addConnection(moduleId, {
      id: "wire-1",
      sourceComponentId: "input",
      sourcePortId: "out",
      targetComponentId: "buffer",
      targetPortId: "a",
    });

    expect(() => store.getState().deleteModulePort(moduleId, "input")).toThrow(
      /connected/i,
    );
    store.getState().addComponent("main", instance("identity-1", moduleId));
    expect(() => store.getState().deleteModule(moduleId)).toThrow(/referenced/i);
  });

  it("protects a boundary port connected through a module instance", () => {
    const store = createProjectStore(emptyProject());
    const moduleId = store.getState().createModule("Identity");
    store.getState().addComponent(moduleId, {
      id: "input",
      typeId: "project.module_input",
      position: { x: 0, y: 0 },
      properties: { portId: "a", label: "A", previewValue: "0" },
    });
    store.getState().addComponent("main", instance("identity-1", moduleId));
    store.getState().addComponent("main", {
      id: "source",
      typeId: "source.constant",
      position: { x: -100, y: 0 },
      properties: { value: "0" },
    });
    store.getState().addConnection("main", {
      id: "wire-1",
      sourceComponentId: "source",
      sourcePortId: "out",
      targetComponentId: "identity-1",
      targetPortId: "a",
    });

    expect(() => store.getState().deleteModulePort(moduleId, "input")).toThrow(
      /connected/i,
    );
  });

  it("rejects unknown and cycle-causing module instances at the write boundary", () => {
    const store = createProjectStore(emptyProject());
    const a = store.getState().createModule("A");
    const b = store.getState().createModule("B");

    expect(() =>
      store.getState().addComponent(a, instance("missing-1", "missing")),
    ).toThrow(/unknown module/i);
    store.getState().addComponent(a, instance("b-in-a", b));
    expect(() =>
      store.getState().addComponent(b, instance("a-in-b", a)),
    ).toThrow(/cycle/i);
  });

  it("renames a module port without changing its stable port ID", () => {
    const store = createProjectStore(emptyProject());
    const moduleId = store.getState().createModule("Identity");
    store.getState().addComponent(moduleId, {
      id: "input",
      typeId: "project.module_input",
      position: { x: 0, y: 0 },
      properties: { portId: "stable-a", label: "A", previewValue: "0" },
    });

    store.getState().renameModulePort(moduleId, "input", "Data In");

    const input = store
      .getState()
      .project.circuits.find((circuit) => circuit.id === moduleId)!
      .components[0];
    expect(input.properties).toMatchObject({
      portId: "stable-a",
      label: "Data In",
    });
    expect(() =>
      store.getState().renameModulePort(moduleId, "missing", "Nope"),
    ).toThrow(/unknown module port/i);
  });

  it("tracks structure and source-value revisions separately", () => {
    const store = createProjectStore(emptyProject());
    const moduleId = store.getState().createModule("Constants");
    const afterStructure = store.getState().structureRevision;
    store.getState().addComponent(moduleId, {
      id: "constant",
      typeId: "source.constant",
      position: { x: 0, y: 0 },
      properties: { value: "0", label: "K" },
    });
    const afterAdd = store.getState();

    store.getState().setSource(moduleId, "constant", "1");

    expect(afterStructure).toBeGreaterThan(0);
    expect(afterAdd.structureRevision).toBeGreaterThan(afterStructure);
    expect(store.getState().structureRevision).toBe(afterAdd.structureRevision);
    expect(store.getState().valueRevision).toBe(afterAdd.valueRevision + 1);
  });

  it("undoes a source in a module with zero instances", () => {
    const store = createProjectStore(emptyProject());
    const moduleId = store.getState().createModule("Spare");
    store.getState().addComponent(moduleId, {
      id: "constant",
      typeId: "source.constant",
      position: { x: 0, y: 0 },
      properties: { value: "0" },
    });
    store.getState().setSource(moduleId, "constant", "T");

    store.getState().undo();

    const constant = store
      .getState()
      .project.circuits.find((circuit) => circuit.id === moduleId)!
      .components[0];
    expect(constant.properties.value).toBe("0");
    expect(store.getState().valueRevision).toBe(2);
  });

  it("falls back to the nearest valid path after undo removes an instance", () => {
    const store = createProjectStore(emptyProject());
    const moduleId = store.getState().createModule("Child");
    store.getState().addComponent("main", instance("child-1", moduleId));
    store.getState().enterInstance("main", "child-1");

    store.getState().undo();

    expect(store.getState().activePath).toEqual([{ circuitId: "main" }]);
  });

  it("persists each circuit viewport while navigation remains session-only", () => {
    const store = createProjectStore(emptyProject());
    const moduleId = store.getState().createModule("Child");
    store.getState().addComponent("main", instance("child-1", moduleId));
    store.getState().setViewport("main", { x: 10, y: 20, zoom: 1.5 });
    const pastLength = store.getState().past.length;

    store.getState().enterInstance("main", "child-1");

    expect(store.getState().project.circuits[0].viewport).toEqual({
      x: 10,
      y: 20,
      zoom: 1.5,
    });
    expect(store.getState().past).toHaveLength(pastLength);
  });

  it("keeps the latest viewport when undo and redo restore document history", () => {
    const store = createProjectStore(emptyProject());
    store.getState().addComponent("main", {
      id: "first",
      typeId: "gate.buf",
      position: { x: 0, y: 0 },
      properties: {},
    });
    store.getState().undo();
    store.getState().setViewport("main", { x: 40, y: 50, zoom: 2 });

    store.getState().redo();

    expect(store.getState().project.circuits[0].viewport).toEqual({
      x: 40,
      y: 50,
      zoom: 2,
    });
  });

  it("restores a module viewport when redo restores the whole module", () => {
    const store = createProjectStore(emptyProject());
    const moduleId = store.getState().createModule("Temporary");
    store.getState().setViewport(moduleId, { x: 7, y: 8, zoom: 1.25 });

    store.getState().undo();
    store.getState().redo();

    expect(
      store
        .getState()
        .project.circuits.find((circuit) => circuit.id === moduleId)?.viewport,
    ).toEqual({ x: 7, y: 8, zoom: 1.25 });
  });

  it("restores per-circuit selections when navigating breadcrumbs", () => {
    const store = createProjectStore(emptyProject());
    const moduleId = store.getState().createModule("Child");
    store.getState().addComponent("main", instance("child-1", moduleId));
    store.getState().setSelection("main", ["child-1"], []);
    store.getState().enterInstance("main", "child-1");
    store.getState().setSelection(moduleId, [], ["wire-draft"]);

    store.getState().navigateToDepth(0);

    expect(store.getState().selectionByCircuit.main).toEqual({
      componentIds: ["child-1"],
      connectionIds: [],
    });
    expect(store.getState().activePath).toEqual([{ circuitId: "main" }]);
  });
});
