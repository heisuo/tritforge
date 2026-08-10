import { describe, expect, it, vi } from "vitest";
import {
  ProjectEditError,
  createProjectStore,
  type ProjectStorePortResolver,
} from "../src/project/project-store";
import type { ProjectDocumentV3 } from "../src/project/project-v3";
import type {
  ProjectModuleInterfaces,
  ResolvedProjectPort,
} from "../src/wasm-client";

function emptyProject(): ProjectDocumentV3 {
  return {
    format: "logsim-ternary",
    version: 3,
    rootCircuitId: "main",
    circuits: [
      {
        id: "main",
        name: "Main",
        kind: "main",
        components: [],
        wires: [],
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

function scalarPorts(typeId: string, width: number): ResolvedProjectPort[] {
  if (typeId === "source.constant" || typeId === "source.trit_input") {
    return [{ id: "out", direction: "output", width }];
  }
  if (typeId === "sink.probe") {
    return [{ id: "in", direction: "input", width }];
  }
  if (typeId === "project.module_input") {
    return [{ id: "out", direction: "output", width }];
  }
  if (typeId === "project.module_output") {
    return [{ id: "in", direction: "input", width }];
  }
  if (typeId === "wiring.junction" || typeId === "wiring.tunnel") {
    return [{ id: "net", direction: "inout", width }];
  }
  if (typeId === "wiring.splitter") {
    return [
      { id: "trunk", direction: "inout", width },
      { id: "branch0", direction: "inout", width: 1 },
      { id: "branch1", direction: "inout", width: width - 1 },
    ];
  }
  if (typeId === "gate.buf") {
    return [
      { id: "a", direction: "input", width: 1 },
      { id: "y", direction: "output", width: 1 },
    ];
  }
  throw Object.assign(new Error(`unknown type ${typeId}`), {
    code: "UNKNOWN_COMPONENT_TYPE",
  });
}

function moduleInterfaces(value: unknown): ProjectModuleInterfaces {
  const project = value as ProjectDocumentV3;
  return Object.fromEntries(
    project.circuits
      .filter((circuit) => circuit.kind === "module")
      .map((circuit) => [
        circuit.id,
        circuit.components
          .filter((component) =>
            component.typeId === "project.module_input" ||
            component.typeId === "project.module_output",
          )
          .map((component) => ({
            id: String(component.properties.portId),
            label: String(component.properties.label),
            direction:
              component.typeId === "project.module_input"
                ? ("input" as const)
                : ("output" as const),
            width: Number(component.properties.width ?? 1),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      ]),
  );
}

function resolver(): ProjectStorePortResolver {
  return {
    resolvePorts(typeId, properties) {
      const width = Number(properties.width ?? 1);
      if (!Number.isInteger(width) || width < 1 || width > 27) {
        throw Object.assign(new Error("invalid signal width"), {
          code: "INVALID_SIGNAL_WIDTH",
        });
      }
      if (typeId === "wiring.tunnel" && !properties.label) {
        throw Object.assign(new Error("tunnel label required"), {
          code: "INVALID_PROPERTY",
        });
      }
      if (typeId === "wiring.splitter") {
        const mapping = properties.mapping;
        const branchCount = properties.branchCount;
        if (
          !Array.isArray(mapping) ||
          mapping.length !== width ||
          branchCount !== 2 ||
          mapping.some((branch) => branch !== 0 && branch !== 1)
        ) {
          throw Object.assign(new Error("invalid splitter mapping"), {
            code: "INVALID_SPLITTER_MAP",
          });
        }
      }
      return scalarPorts(typeId, width);
    },
    resolveModuleInterfaces: moduleInterfaces,
  };
}

function wordValidatingResolver(): ProjectStorePortResolver {
  const base = resolver();
  return {
    resolvePorts: vi.fn((typeId, properties) => {
      const width = Number(properties.width ?? 1);
      const value =
        typeId === "project.module_input"
          ? properties.previewValue
          : typeId === "source.constant" || typeId === "source.trit_input"
            ? properties.value
            : undefined;
      if (
        value !== undefined &&
        (typeof value !== "string" ||
          !/^[T01]+$/.test(value) ||
          value.length !== width)
      ) {
        throw Object.assign(new Error("invalid known word"), {
          code: "INVALID_WORD",
        });
      }
      return base.resolvePorts(typeId, properties);
    }),
    resolveModuleInterfaces: base.resolveModuleInterfaces,
  };
}

function component(
  id: string,
  typeId: string,
  properties: Record<string, unknown>,
) {
  return { id, typeId, position: { x: 0, y: 0 }, properties };
}

function addWordEndpoints(
  store: ReturnType<typeof createProjectStore>,
  sourceWidth = 3,
  probeWidth = 3,
) {
  store.getState().addComponent(
    "main",
    component("source", "source.constant", {
      width: sourceWidth,
      value: "0".repeat(sourceWidth),
    }),
  );
  store.getState().addComponent(
    "main",
    component("probe", "sink.probe", { width: probeWidth }),
  );
}

describe("project v3 store", () => {
  it("normalizes imported wires at every store and history boundary", () => {
    const imported = emptyProject();
    imported.circuits[0].components = [
      component("z-source", "source.constant", { width: 1, value: "1" }),
      component("a-probe", "sink.probe", { width: 1 }),
    ];
    imported.circuits[0].wires = [
      {
        id: "wire-reversed",
        endpointA: { componentId: "z-source", portId: "out" },
        endpointB: { componentId: "a-probe", portId: "in" },
      },
    ];
    const store = createProjectStore(imported, { portResolver: resolver() });

    expect(store.getState().project.circuits[0].wires[0]).toMatchObject({
      id: "wire-reversed",
      endpointA: { componentId: "a-probe", portId: "in" },
      endpointB: { componentId: "z-source", portId: "out" },
    });

    const replacement = structuredClone(imported);
    replacement.circuits[0].wires[0] = {
      id: "wire-reversed",
      endpointA: { componentId: "z-source", portId: "out" },
      endpointB: { componentId: "a-probe", portId: "in" },
    };
    replacement.circuits[0].components[0].properties.value = "T";
    store.getState().replaceProject(replacement);
    store.getState().undo();
    store.getState().redo();

    for (const project of [
      store.getState().project,
      ...store.getState().past,
      ...store.getState().future,
    ]) {
      expect(project.circuits[0].wires[0].endpointA.componentId).toBe("a-probe");
      expect(project.circuits[0].wires[0].endpointB.componentId).toBe("z-source");
    }
  });

  it("allocates collision-free module IDs and enters shared definitions", () => {
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });

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

  it("preserves a valid module path when replacing with the exact current project", () => {
    const applyProject = vi.fn();
    const store = createProjectStore(emptyProject(), {
      portResolver: resolver(),
      applyProject,
    });
    const moduleId = store.getState().createModule("Identity");
    store.getState().addComponent("main", instance("identity-1", moduleId));
    store.getState().enterInstance("main", "identity-1");
    const beforePath = structuredClone(store.getState().activePath);
    const beforePast = structuredClone(store.getState().past);
    applyProject.mockClear();

    store.getState().replaceProject(structuredClone(store.getState().project));

    expect(store.getState().activePath).toEqual(beforePath);
    expect(store.getState().past).toEqual(beforePast);
    expect(applyProject).not.toHaveBeenCalled();
  });

  it("does not reuse a cached source shape before Rust validates a changed value", () => {
    const validating = wordValidatingResolver();
    const store = createProjectStore(emptyProject(), {
      portResolver: validating,
    });
    store.getState().addComponent(
      "main",
      component("source", "source.constant", { width: 3, value: "1T0" }),
    );
    const before = structuredClone(store.getState().project);

    expect(() =>
      store.getState().setComponentProperties("main", "source", {
        width: 3,
        value: "XXX",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WORD" }));
    expect(store.getState().project).toEqual(before);
    expect(validating.resolvePorts).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a cached module-input shape before Rust validates previewValue", () => {
    const validating = wordValidatingResolver();
    const store = createProjectStore(emptyProject(), {
      portResolver: validating,
    });
    const moduleId = store.getState().createModule("Identity");
    store.getState().addComponent(
      moduleId,
      component("input", "project.module_input", {
        portId: "a",
        label: "A",
        width: 1,
        previewValue: "0",
      }),
    );
    const before = structuredClone(store.getState().project);

    expect(() =>
      store.getState().setComponentProperties(moduleId, "input", {
        portId: "a",
        label: "A",
        width: 1,
        previewValue: "X",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WORD" }));
    expect(store.getState().project).toEqual(before);
    expect(validating.resolvePorts).toHaveBeenCalledTimes(2);
  });

  it("stores only v3 documents and creates the same normalized wire in either endpoint order", () => {
    const first = createProjectStore(emptyProject(), { portResolver: resolver() });
    const second = createProjectStore(emptyProject(), { portResolver: resolver() });
    addWordEndpoints(first);
    addWordEndpoints(second);

    first.getState().addWire("main", {
      id: "wire-stable",
      endpointA: { componentId: "source", portId: "out" },
      endpointB: { componentId: "probe", portId: "in" },
    });
    second.getState().addWire("main", {
      id: "wire-stable",
      endpointA: { componentId: "probe", portId: "in" },
      endpointB: { componentId: "source", portId: "out" },
    });

    expect(first.getState().project.version).toBe(3);
    expect(first.getState().project.circuits[0].wires).toEqual(
      second.getState().project.circuits[0].wires,
    );
    expect(first.getState().project.circuits[0].wires[0].id).toBe("wire-stable");
  });

  it("rejects width mismatches atomically with a stable code", () => {
    const applyProject = vi.fn();
    const store = createProjectStore(emptyProject(), {
      portResolver: resolver(),
      applyProject,
    });
    addWordEndpoints(store, 3, 1);
    applyProject.mockClear();
    const beforeState = store.getState();
    const before = {
      project: structuredClone(beforeState.project),
      past: structuredClone(beforeState.past),
      future: structuredClone(beforeState.future),
      structureRevision: beforeState.structureRevision,
      valueRevision: beforeState.valueRevision,
    };

    expect(() =>
      store.getState().addWire("main", {
        id: "bad-width",
        endpointA: { componentId: "source", portId: "out" },
        endpointB: { componentId: "probe", portId: "in" },
      }),
    ).toThrowError(expect.objectContaining({ code: "WIDTH_MISMATCH" }));

    const after = store.getState();
    expect(after.project).toEqual(before.project);
    expect(after.past).toEqual(before.past);
    expect(after.future).toEqual(before.future);
    expect(after.structureRevision).toBe(before.structureRevision);
    expect(after.valueRevision).toBe(before.valueRevision);
    expect(applyProject).not.toHaveBeenCalled();
  });

  it("uses injected dynamic ports, rejects missing ports, and permits endpoint fanout", () => {
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
    addWordEndpoints(store);
    store.getState().addComponent(
      "main",
      component("split", "wiring.splitter", {
        width: 3,
        branchCount: 2,
        mapping: [0, 1, 1],
      }),
    );
    store.getState().addComponent(
      "main",
      component("probe-2", "sink.probe", { width: 3 }),
    );

    expect(() =>
      store.getState().addWire("main", {
        id: "missing-port",
        endpointA: { componentId: "split", portId: "branch9" },
        endpointB: { componentId: "probe", portId: "in" },
      }),
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_PORT" }));

    store.getState().addWire("main", {
      id: "fanout-a",
      endpointA: { componentId: "source", portId: "out" },
      endpointB: { componentId: "probe", portId: "in" },
    });
    store.getState().addWire("main", {
      id: "fanout-b",
      endpointA: { componentId: "source", portId: "out" },
      endpointB: { componentId: "probe-2", portId: "in" },
    });
    expect(store.getState().project.circuits[0].wires).toHaveLength(2);
  });

  it("lets the accepted runtime compile perform whole-project validation once", () => {
    const applyProject = vi.fn((project: ProjectDocumentV3) => {
      if (project.circuits.some((circuit) =>
        circuit.wires.some((wire) => wire.id === "compiler-rejects"),
      )) {
        throw Object.assign(new Error("candidate project rejected"), {
          code: "MULTIPLE_DRIVERS",
        });
      }
    });
    const store = createProjectStore(emptyProject(), {
      portResolver: resolver(),
      applyProject,
    });
    addWordEndpoints(store);
    applyProject.mockClear();

    expect(() =>
      store.getState().addWire("main", {
        id: "compiler-rejects",
        endpointA: { componentId: "source", portId: "out" },
        endpointB: { componentId: "probe", portId: "in" },
      }),
    ).toThrowError(expect.objectContaining({ code: "MULTIPLE_DRIVERS" }));
    expect(store.getState().project.circuits[0].wires).toEqual([]);
    expect(applyProject).toHaveBeenCalledTimes(1);
  });

  it("records width and splitter mapping property edits as one undo step each", () => {
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
    store.getState().addComponent(
      "main",
      component("word", "source.constant", { width: 3, value: "1T0" }),
    );
    store.getState().addComponent(
      "main",
      component("split", "wiring.splitter", {
        width: 3,
        branchCount: 2,
        mapping: [0, 1, 1],
      }),
    );

    const beforeWidth = store.getState().past.length;
    store.getState().setComponentProperties("main", "word", {
      width: 6,
      value: "0001T0",
    });
    expect(store.getState().past).toHaveLength(beforeWidth + 1);
    store.getState().undo();
    expect(store.getState().project.circuits[0].components[0].properties.width).toBe(3);
    store.getState().redo();

    const beforeMapping = store.getState().past.length;
    store.getState().setComponentProperties("main", "split", {
      width: 3,
      branchCount: 2,
      mapping: [1, 0, 0],
    });
    expect(store.getState().past).toHaveLength(beforeMapping + 1);
    store.getState().undo();
    expect(store.getState().project.circuits[0].components[1].properties.mapping).toEqual([
      0, 1, 1,
    ]);
  });

  it("leaves document, history, revisions, and runtime callback untouched after a failed property edit", () => {
    const applyProject = vi.fn();
    const store = createProjectStore(emptyProject(), {
      portResolver: resolver(),
      applyProject,
    });
    store.getState().addComponent(
      "main",
      component("split", "wiring.splitter", {
        width: 3,
        branchCount: 2,
        mapping: [0, 1, 1],
      }),
    );
    applyProject.mockClear();
    const beforeProject = structuredClone(store.getState().project);
    const beforePast = structuredClone(store.getState().past);
    const beforeStructure = store.getState().structureRevision;

    expect(() =>
      store.getState().setComponentProperties("main", "split", {
        width: 3,
        branchCount: 2,
        mapping: [0, 2, 1],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SPLITTER_MAP" }));
    expect(store.getState().project).toEqual(beforeProject);
    expect(store.getState().past).toEqual(beforePast);
    expect(store.getState().structureRevision).toBe(beforeStructure);
    expect(applyProject).not.toHaveBeenCalled();
  });

  it("protects boundary ports used by local wires and module-instance wires", () => {
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
    const moduleId = store.getState().createModule("Identity");
    store.getState().addComponent(
      moduleId,
      component("input", "project.module_input", {
        portId: "a",
        label: "A",
        previewValue: "0",
      }),
    );
    store.getState().addComponent(
      moduleId,
      component("buffer", "gate.buf", {}),
    );
    store.getState().addWire(moduleId, {
      id: "local",
      endpointA: { componentId: "input", portId: "out" },
      endpointB: { componentId: "buffer", portId: "a" },
    });
    expect(() => store.getState().deleteModulePort(moduleId, "input")).toThrow(
      /connected/i,
    );

    const outer = createProjectStore(emptyProject(), { portResolver: resolver() });
    const outerModule = outer.getState().createModule("Identity");
    outer.getState().addComponent(
      outerModule,
      component("input", "project.module_input", {
        portId: "a",
        label: "A",
        previewValue: "0",
      }),
    );
    outer.getState().addComponent("main", instance("identity-1", outerModule));
    outer.getState().addComponent(
      "main",
      component("source", "source.constant", { value: "0" }),
    );
    outer.getState().addWire("main", {
      id: "instance-use",
      endpointA: { componentId: "source", portId: "out" },
      endpointB: { componentId: "identity-1", portId: "a" },
    });
    expect(() => outer.getState().deleteModulePort(outerModule, "input")).toThrow(
      /connected/i,
    );
  });

  it("protects referenced modules from deletion", () => {
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
    const moduleId = store.getState().createModule("Identity");
    store.getState().addComponent("main", instance("identity-1", moduleId));

    expect(() => store.getState().deleteModule(moduleId)).toThrow(/referenced/i);
  });

  it("rejects unknown and cycle-causing module instances at the write boundary", () => {
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
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
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
    const moduleId = store.getState().createModule("Identity");
    store.getState().addComponent(
      moduleId,
      component("input", "project.module_input", {
        portId: "stable-a",
        label: "A",
        previewValue: "0",
      }),
    );

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

  it("sets exact-width source words while retaining scalar compatibility and revision separation", () => {
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
    store.getState().addComponent(
      "main",
      component("word", "source.constant", { width: 3, value: "000" }),
    );
    const structural = store.getState().structureRevision;

    store.getState().setSource("main", "word", "1T0");
    expect(store.getState().project.circuits[0].components[0].properties.value).toBe(
      "1T0",
    );
    expect(store.getState().structureRevision).toBe(structural);
    expect(store.getState().valueRevision).toBe(1);
    expect(() => store.getState().setSource("main", "word", "1")).toThrowError(
      expect.objectContaining({ code: "INVALID_WORD" }),
    );

    const scalar = createProjectStore(emptyProject(), { portResolver: resolver() });
    scalar.getState().addComponent(
      "main",
      component("one", "source.trit_input", { value: "0" }),
    );
    scalar.getState().setSource("main", "one", "T");
    expect(scalar.getState().project.circuits[0].components[0].properties.value).toBe(
      "T",
    );
  });

  it("undoes a source in a module with zero instances", () => {
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
    const moduleId = store.getState().createModule("Spare");
    store.getState().addComponent(
      moduleId,
      component("constant", "source.constant", { value: "0" }),
    );
    store.getState().setSource(moduleId, "constant", "T");

    store.getState().undo();

    const constant = store
      .getState()
      .project.circuits.find((circuit) => circuit.id === moduleId)!
      .components[0];
    expect(constant.properties.value).toBe("0");
    expect(store.getState().valueRevision).toBe(2);
  });

  it("keeps the latest viewport when undo and redo restore document history", () => {
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
    store.getState().addComponent(
      "main",
      component("first", "gate.buf", {}),
    );
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
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
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

  it("preserves hierarchy, wire selections, viewports, and v3 history", () => {
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
    const moduleId = store.getState().createModule("Child");
    store.getState().addComponent("main", instance("child-1", moduleId));
    store.getState().setSelection("main", ["child-1"], ["wire-draft"]);
    store.getState().setViewport("main", { x: 10, y: 20, zoom: 1.5 });
    store.getState().enterInstance("main", "child-1");
    const beforeUndo = store.getState().past.length;

    store.getState().undo();

    expect(store.getState().activePath).toEqual([{ circuitId: "main" }]);
    expect(store.getState().selectionByCircuit.main).toEqual({
      componentIds: [],
      wireIds: [],
    });
    expect(store.getState().project.version).toBe(3);
    expect(store.getState().past).toHaveLength(beforeUndo - 1);
    expect(store.getState().project.circuits[0].viewport).toEqual({
      x: 10,
      y: 20,
      zoom: 1.5,
    });
  });

  it("keeps error codes available on typed edit errors", () => {
    const error = new ProjectEditError("WIDTH_MISMATCH", "nope");
    expect(error).toMatchObject({ name: "ProjectEditError", code: "WIDTH_MISMATCH" });
  });

  it("runs an installed runtime applier before every semantic commit and rolls back on failure", () => {
    const accepted: string[] = [];
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
    store.getState().setApplyProject((project) => {
      const count = project.circuits[0].components.length;
      accepted.push(`components:${count}`);
      if (count === 2) throw new Error("runtime rejected candidate");
    });

    store.getState().addComponent(
      "main",
      component("source", "source.constant", { width: 1, value: "0" }),
    );
    const before = {
      project: structuredClone(store.getState().project),
      past: structuredClone(store.getState().past),
      structureRevision: store.getState().structureRevision,
    };
    expect(() =>
      store.getState().addComponent(
        "main",
        component("probe", "sink.probe", { width: 1 }),
      ),
    ).toThrow("runtime rejected candidate");
    expect(store.getState().project).toEqual(before.project);
    expect(store.getState().past).toEqual(before.past);
    expect(store.getState().structureRevision).toBe(before.structureRevision);

    store.getState().undo();
    store.getState().redo();
    expect(accepted).toEqual([
      "components:1",
      "components:2",
      "components:0",
      "components:1",
    ]);
  });

  it("sanitizes component and wire selections after edits, replace, undo, and redo", () => {
    const store = createProjectStore(emptyProject(), { portResolver: resolver() });
    addWordEndpoints(store, 1, 1);
    store.getState().addWire("main", {
      id: "wire-1",
      endpointA: { componentId: "source", portId: "out" },
      endpointB: { componentId: "probe", portId: "in" },
    });
    store.getState().setSelection("main", ["source", "missing"], ["wire-1", "gone"]);

    store.getState().setCircuit("main", {
      components: [
        component("source", "source.constant", { width: 1, value: "0" }),
      ],
      wires: [],
    });
    expect(store.getState().selectionByCircuit.main).toEqual({
      componentIds: ["source"],
      wireIds: [],
    });

    store.getState().undo();
    expect(store.getState().selectionByCircuit.main).toEqual({
      componentIds: ["source"],
      wireIds: [],
    });
    store.getState().redo();
    expect(store.getState().selectionByCircuit.main).toEqual({
      componentIds: ["source"],
      wireIds: [],
    });

    store.getState().replaceProject(emptyProject());
    expect(store.getState().selectionByCircuit).toEqual({});
  });

  it("caches Rust port shapes and skips semantic resolution for position-only edits", () => {
    const base = resolver();
    const tracked: ProjectStorePortResolver = {
      resolvePorts: vi.fn(base.resolvePorts),
      resolveModuleInterfaces: vi.fn(base.resolveModuleInterfaces),
    };
    const applyProject = vi.fn();
    const store = createProjectStore(emptyProject(), {
      portResolver: tracked,
      applyProject,
    });
    addWordEndpoints(store);
    store.getState().addWire("main", {
      id: "wire-1",
      endpointA: { componentId: "source", portId: "out" },
      endpointB: { componentId: "probe", portId: "in" },
    });
    const portCalls = vi.mocked(tracked.resolvePorts).mock.calls.length;
    const interfaceCalls = vi.mocked(tracked.resolveModuleInterfaces).mock.calls.length;
    applyProject.mockClear();

    const circuit = store.getState().project.circuits[0];
    store.getState().setCircuit("main", {
      components: circuit.components.map((item, index) => ({
        ...item,
        position: { x: index * 100 + 12, y: 34 },
      })),
      wires: circuit.wires,
    });

    expect(tracked.resolvePorts).toHaveBeenCalledTimes(portCalls);
    expect(tracked.resolveModuleInterfaces).toHaveBeenCalledTimes(interfaceCalls);
    expect(applyProject).not.toHaveBeenCalled();
  });
});
