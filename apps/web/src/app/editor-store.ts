import { createStore, type StoreApi } from "zustand/vanilla";
import {
  cloneCircuitDocument,
  createEmptyCircuitDocument,
  type CircuitDocument,
  type EditorComponent,
  type EditorConnection,
} from "../editor/circuit-document";

export type { EditorComponent, EditorConnection } from "../editor/circuit-document";

export interface EditorSelection {
  componentIds: string[];
  connectionIds: string[];
}

export interface EditorStoreState {
  past: CircuitDocument[];
  document: CircuitDocument;
  future: CircuitDocument[];
  selection: EditorSelection;
  setDocument: (document: CircuitDocument, recordHistory?: boolean) => void;
  checkpoint: (previous: CircuitDocument) => void;
  addComponent: (component: EditorComponent) => void;
  addConnection: (connection: EditorConnection) => void;
  updateComponent: (
    componentId: string,
    update: Partial<Omit<EditorComponent, "id">>,
    recordHistory?: boolean,
  ) => void;
  setSelection: (componentIds: string[], connectionIds: string[]) => void;
  deleteSelection: () => void;
  load: (document: CircuitDocument) => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;
}

const EMPTY_SELECTION: EditorSelection = {
  componentIds: [],
  connectionIds: [],
};

function documentsEqual(left: CircuitDocument, right: CircuitDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createEditorStore(
  initialDocument: CircuitDocument = createEmptyCircuitDocument(),
): StoreApi<EditorStoreState> {
  return createStore<EditorStoreState>((set, get) => {
    const commit = (nextDocument: CircuitDocument) => {
      const current = get().document;
      if (documentsEqual(current, nextDocument)) {
        return;
      }
      set((state) => ({
        past: [...state.past, cloneCircuitDocument(current)],
        document: cloneCircuitDocument(nextDocument),
        future: [],
      }));
    };

    return {
      past: [],
      document: cloneCircuitDocument(initialDocument),
      future: [],
      selection: EMPTY_SELECTION,
      setDocument: (document, recordHistory = true) => {
        if (recordHistory) {
          commit(document);
        } else {
          set({ document: cloneCircuitDocument(document) });
        }
      },
      checkpoint: (previous) => {
        const current = get().document;
        if (documentsEqual(previous, current)) {
          return;
        }
        set((state) => ({
          past: [...state.past, cloneCircuitDocument(previous)],
          future: [],
        }));
      },
      addComponent: (component) => {
        const current = get().document;
        if (current.components.some((item) => item.id === component.id)) {
          throw new Error(`Duplicate component ID: ${component.id}`);
        }
        commit({
          ...current,
          components: [
            ...current.components,
            {
              ...component,
              position: { ...component.position },
              properties: { ...component.properties },
            },
          ],
        });
      },
      addConnection: (connection) => {
        const current = get().document;
        if (current.connections.some((item) => item.id === connection.id)) {
          throw new Error(`Duplicate connection ID: ${connection.id}`);
        }
        commit({
          ...current,
          connections: [...current.connections, { ...connection }],
        });
      },
      updateComponent: (componentId, update, recordHistory = true) => {
        const current = get().document;
        const next = {
          ...current,
          components: current.components.map((component) =>
            component.id === componentId
              ? {
                  ...component,
                  ...update,
                  position: update.position
                    ? { ...update.position }
                    : component.position,
                  properties: update.properties
                    ? { ...update.properties }
                    : component.properties,
                }
              : component,
          ),
        };
        if (recordHistory) {
          commit(next);
        } else {
          set({ document: cloneCircuitDocument(next) });
        }
      },
      setSelection: (componentIds, connectionIds) => {
        set({
          selection: {
            componentIds: [...componentIds],
            connectionIds: [...connectionIds],
          },
        });
      },
      deleteSelection: () => {
        const { document, selection } = get();
        const componentIds = new Set(selection.componentIds);
        const connectionIds = new Set(selection.connectionIds);
        commit({
          ...document,
          components: document.components.filter(
            (component) => !componentIds.has(component.id),
          ),
          connections: document.connections.filter(
            (connection) =>
              !connectionIds.has(connection.id) &&
              !componentIds.has(connection.sourceComponentId) &&
              !componentIds.has(connection.targetComponentId),
          ),
        });
        set({ selection: EMPTY_SELECTION });
      },
      load: (document) => {
        commit(cloneCircuitDocument(document));
        set({ selection: EMPTY_SELECTION });
      },
      clear: () => {
        commit(createEmptyCircuitDocument());
        set({ selection: EMPTY_SELECTION });
      },
      undo: () => {
        const state = get();
        const previous = state.past.at(-1);
        if (!previous) {
          return;
        }
        set({
          past: state.past.slice(0, -1),
          document: cloneCircuitDocument(previous),
          future: [cloneCircuitDocument(state.document), ...state.future],
          selection: EMPTY_SELECTION,
        });
      },
      redo: () => {
        const state = get();
        const next = state.future[0];
        if (!next) {
          return;
        }
        set({
          past: [...state.past, cloneCircuitDocument(state.document)],
          document: cloneCircuitDocument(next),
          future: state.future.slice(1),
          selection: EMPTY_SELECTION,
        });
      },
    };
  });
}
