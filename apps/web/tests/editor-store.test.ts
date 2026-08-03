import { describe, expect, it } from "vitest";
import {
  createEditorStore,
  type EditorConnection,
  type EditorComponent,
} from "../src/app/editor-store";
import { createEmptyCircuitDocument } from "../src/editor/circuit-document";
import { makeConnectionId } from "../src/editor-model";

const input: EditorComponent = {
  id: "input-1",
  typeId: "source.trit_input",
  position: { x: 20, y: 30 },
  properties: { value: "0", label: "Input" },
};

const probe: EditorComponent = {
  id: "probe-1",
  typeId: "sink.probe",
  position: { x: 300, y: 30 },
  properties: { label: "Probe" },
};

const connection: EditorConnection = {
  id: "wire-1",
  sourceComponentId: "input-1",
  sourcePortId: "out",
  targetComponentId: "probe-1",
  targetPortId: "in",
};

describe("editor store history", () => {
  it("allocates a free connection ID after importing existing wires", () => {
    expect(makeConnectionId([
      { id: "wire-1", source: "a", target: "b" },
      { id: "wire-3", source: "b", target: "c" },
    ])).toBe("wire-2");
  });

  it("undoes and redoes document edits", () => {
    const store = createEditorStore(createEmptyCircuitDocument());
    store.getState().addComponent(input);
    store.getState().addComponent(probe);
    store.getState().addConnection(connection);

    store.getState().undo();
    expect(store.getState().document.connections).toEqual([]);
    store.getState().redo();
    expect(store.getState().document.connections).toEqual([connection]);
  });

  it("deletes attached connections and clears the document", () => {
    const store = createEditorStore(createEmptyCircuitDocument());
    store.getState().addComponent(input);
    store.getState().addComponent(probe);
    store.getState().addConnection(connection);
    store.getState().setSelection(["input-1"], []);
    store.getState().deleteSelection();

    expect(store.getState().document.components).toEqual([probe]);
    expect(store.getState().document.connections).toEqual([]);
    store.getState().clear();
    expect(store.getState().document.components).toEqual([]);
  });

  it("does not record selection changes and deep-clones loaded documents", () => {
    const store = createEditorStore(createEmptyCircuitDocument());
    const example = {
      ...createEmptyCircuitDocument(),
      components: [input],
    };
    store.getState().load(example);
    store.getState().setSelection(["input-1"], []);

    expect(store.getState().past).toHaveLength(1);
    store.getState().document.components[0].properties.label = "mutated";
    expect(example.components[0].properties.label).toBe("Input");
  });
});
