import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Activity,
  Box,
  CircleDot,
  Gauge,
  Maximize2,
  MousePointer2,
  Plus,
  Radio,
  RotateCcw,
  Trash2,
  Triangle,
  Workflow,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { CircuitNode, SIGNAL_COLORS } from "./CircuitNode";
import {
  createDefaultDocument,
  cycleKnownTrit,
  makeComponentId,
  toCircuitDefinition,
  validateConnection,
  type CatalogComponent,
  type EditorDocument,
  type EditorEdge,
  type EditorNode,
  type KnownTrit,
  type TritSymbol,
} from "./editor-model";
import {
  createWasmRuntime,
  wasmErrorMessage,
  type SimulationSnapshot,
  type WasmRuntime,
} from "./wasm-client";

const nodeTypes = { component: CircuitNode };
const DISPLAY_NAMES: Record<string, string> = {
  "source.trit_input": "Trit Input",
  "source.constant": "Constant",
  "sink.probe": "Probe",
  "gate.buf": "BUF",
  "gate.neg": "NEG",
  "gate.min": "MIN",
  "gate.max": "MAX",
  "gate.is_neg": "IS_NEG",
  "gate.is_zero": "IS_ZERO",
  "gate.is_pos": "IS_POS",
  "gate.mux2": "MUX2",
  "gate.mux3": "MUX3",
};

function descriptorIcon(descriptor: CatalogComponent) {
  if (descriptor.type_id === "source.trit_input") {
    return Radio;
  }
  if (descriptor.type_id === "source.constant") {
    return Box;
  }
  if (descriptor.type_id === "sink.probe") {
    return Gauge;
  }
  if (descriptor.type_id.includes("mux")) {
    return Triangle;
  }
  return CircleDot;
}

function topologyKey(document: EditorDocument): string {
  return JSON.stringify({
    components: document.nodes.map((node) => [node.id, node.data.typeId]),
    connections: document.edges.map((edge) => [
      edge.source,
      edge.sourceHandle,
      edge.target,
      edge.targetHandle,
    ]),
  });
}

function edgeSignal(
  edge: EditorEdge,
  snapshot: SimulationSnapshot | null,
): TritSymbol {
  if (!edge.sourceHandle) {
    return "Z";
  }
  return snapshot?.component_outputs[edge.source]?.[edge.sourceHandle] ?? "Z";
}

function Workbench() {
  const initial = useMemo(createDefaultDocument, []);
  const [nodes, setNodes] = useState<EditorNode[]>(initial.nodes);
  const [edges, setEdges] = useState<EditorEdge[]>(initial.edges);
  const [catalog, setCatalog] = useState<CatalogComponent[]>([]);
  const [snapshot, setSnapshot] = useState<SimulationSnapshot | null>(null);
  const [wasmState, setWasmState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [wasmVersion, setWasmVersion] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState("正在加载 Rust/WASM…");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [reloadRevision, setReloadRevision] = useState(0);
  const runtimeRef = useRef<WasmRuntime | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ReactFlowInstance<EditorNode, EditorEdge> | null>(
    null,
  );
  const edgeCounter = useRef(1);

  const document = useMemo(() => ({ nodes, edges }), [nodes, edges]);
  const circuitKey = useMemo(() => topologyKey(document), [document]);

  useEffect(() => {
    let active = true;
    createWasmRuntime()
      .then((runtime) => {
        if (!active) {
          return;
        }
        runtimeRef.current = runtime;
        setCatalog(runtime.catalog);
        setWasmVersion(runtime.apiVersion);
        setWasmState("ready");
        setStatusMessage("Rust/WASM 模拟器已就绪");
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setWasmState("error");
        setStatusMessage(`WASM 加载失败：${wasmErrorMessage(error)}`);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || wasmState !== "ready") {
      return;
    }
    try {
      setSnapshot(runtime.simulator.loadCircuit(toCircuitDefinition(document)));
      setStatusMessage("电路已由 Rust/WASM 求值");
    } catch (error) {
      setSnapshot(null);
      setStatusMessage(`电路加载失败：${wasmErrorMessage(error)}`);
    }
  }, [circuitKey, reloadRevision, wasmState]);

  const catalogByType = useMemo(
    () => new Map(catalog.map((item) => [item.type_id, item])),
    [catalog],
  );

  const renderedNodes = useMemo(
    () =>
      nodes.map((node) => {
        const descriptor = catalogByType.get(node.data.typeId);
        return {
          ...node,
          data: {
            ...node.data,
            ports: descriptor?.ports ?? [],
            inputSignals: snapshot?.input_nets[node.id] ?? {},
            outputSignals: snapshot?.component_outputs[node.id] ?? {},
          },
        };
      }),
    [catalogByType, nodes, snapshot],
  );

  const renderedEdges = useMemo(
    () =>
      edges.map((edge) => {
        const signal = edgeSignal(edge, snapshot);
        return {
          ...edge,
          label: signal,
          labelStyle: {
            fill: SIGNAL_COLORS[signal],
            fontSize: 12,
            fontWeight: 800,
          },
          labelBgStyle: { fill: "#ffffff", fillOpacity: 0.92 },
          labelBgPadding: [4, 3] as [number, number],
          labelBgBorderRadius: 2,
          style: {
            stroke: SIGNAL_COLORS[signal],
            strokeWidth: 2.2,
          },
        };
      }),
    [edges, snapshot],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<EditorNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
    },
    [],
  );

  const onEdgesChange = useCallback((changes: EdgeChange<EditorEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const isValidConnection = useCallback(
    (connection: Connection | EditorEdge) =>
      validateConnection(connection, document, catalog).valid,
    [catalog, document],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const result = validateConnection(connection, document, catalog);
      if (!result.valid) {
        const messages = {
          duplicate: "已拒绝完全重复的连线",
          invalid_direction: "连线必须从输出端口指向输入端口",
          missing_endpoint: "连线端点不存在",
        };
        setStatusMessage(messages[result.reason]);
        return;
      }
      const edge: EditorEdge = {
        ...connection,
        id: `wire-${edgeCounter.current++}`,
      };
      setEdges((current) => addEdge(edge, current));
      setStatusMessage("已添加连线，正在重新求值");
    },
    [catalog, document],
  );

  const addComponent = useCallback(
    (typeId: string, position?: { x: number; y: number }) => {
      const descriptor = catalogByType.get(typeId);
      if (!descriptor) {
        return;
      }
      let nextPosition = position;
      if (!nextPosition) {
        const bounds = flowRef.current?.getBoundingClientRect();
        nextPosition =
          bounds && instanceRef.current
            ? instanceRef.current.screenToFlowPosition({
                x: bounds.left + bounds.width / 2,
                y: bounds.top + bounds.height / 2,
              })
            : { x: 420, y: 280 };
      }
      const id = makeComponentId(typeId, nodes);
      const sourceValue =
        descriptor.category === "source" ? ("0" as KnownTrit) : undefined;
      setNodes((current) => [
        ...current,
        {
          id,
          type: "component",
          position: nextPosition,
          data: {
            typeId,
            label: DISPLAY_NAMES[typeId] ?? descriptor.display_name,
            ...(sourceValue ? { sourceValue } : {}),
          },
        },
      ]);
      setSelectedNodeId(id);
      setStatusMessage(`已添加 ${DISPLAY_NAMES[typeId] ?? descriptor.display_name}`);
    },
    [catalogByType, nodes],
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: EditorNode) => {
      setSelectedNodeId(node.id);
      setSelectedEdgeIds([]);
      if (node.data.typeId !== "source.trit_input") {
        return;
      }
      const current = node.data.sourceValue ?? "0";
      const next = cycleKnownTrit(current);
      try {
        const nextSnapshot = runtimeRef.current?.simulator.setInput(node.id, next);
        if (!nextSnapshot) {
          return;
        }
        setNodes((allNodes) =>
          allNodes.map((item) =>
            item.id === node.id
              ? { ...item, data: { ...item.data, sourceValue: next } }
              : item,
          ),
        );
        setSnapshot(nextSnapshot);
        setStatusMessage(`输入 ${node.id}：${current} → ${next}`);
      } catch (error) {
        setStatusMessage(`输入更新失败：${wasmErrorMessage(error)}`);
      }
    },
    [],
  );

  const deleteSelected = useCallback(() => {
    const nodeIds = new Set(
      nodes.filter((node) => node.selected).map((node) => node.id),
    );
    const edgeIds = new Set([
      ...selectedEdgeIds,
      ...edges.filter((edge) => edge.selected).map((edge) => edge.id),
    ]);
    if (selectedNodeId) {
      nodeIds.add(selectedNodeId);
    }
    setNodes((current) => current.filter((node) => !nodeIds.has(node.id)));
    setEdges((current) =>
      current.filter(
        (edge) =>
          !edgeIds.has(edge.id) &&
          !nodeIds.has(edge.source) &&
          !nodeIds.has(edge.target),
      ),
    );
    setSelectedNodeId(null);
    setSelectedEdgeIds([]);
    setStatusMessage("已删除所选元件或连线");
  }, [edges, nodes, selectedEdgeIds, selectedNodeId]);

  const resetDefault = useCallback(() => {
    const next = createDefaultDocument();
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedNodeId(null);
    setSelectedEdgeIds([]);
    setReloadRevision((value) => value + 1);
    setStatusMessage("已恢复默认示例");
    requestAnimationFrame(() =>
      instanceRef.current?.fitView({ padding: 0.28, duration: 250 }),
    );
  }, []);

  const clearDocument = useCallback(() => {
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    setSelectedEdgeIds([]);
    setReloadRevision((value) => value + 1);
    setStatusMessage("画布已清空");
  }, []);

  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams) => {
      setSelectedNodeId(selectedNodes.at(-1)?.id ?? null);
      setSelectedEdgeIds(selectedEdges.map((edge) => edge.id));
    },
    [],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const typeId = event.dataTransfer.getData(
        "application/logsim-component",
      );
      if (!typeId || !instanceRef.current) {
        return;
      }
      addComponent(
        typeId,
        instanceRef.current.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        }),
      );
    },
    [addComponent],
  );

  const selectedNode =
    nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedDescriptor = selectedNode
    ? catalogByType.get(selectedNode.data.typeId) ?? null
    : null;

  return (
    <main className="app-shell" aria-label="Logsim Ternary 编辑器">
      <header className="topbar">
        <div className="brand">
          <Workflow aria-hidden="true" />
          <strong>LOGSIM TERNARY</strong>
          <span>QUICK DEMO</span>
        </div>
        <div className="toolbar" role="toolbar" aria-label="画布工具">
          <button type="button" onClick={resetDefault}>
            <RotateCcw aria-hidden="true" />
            默认示例
          </button>
          <button type="button" onClick={clearDocument}>
            <Trash2 aria-hidden="true" />
            清空
          </button>
          <button
            type="button"
            onClick={() =>
              instanceRef.current?.fitView({ padding: 0.25, duration: 250 })
            }
          >
            <Maximize2 aria-hidden="true" />
            适应画布
          </button>
          <span className="toolbar-divider" />
          <button
            className="icon-button"
            type="button"
            title="删除所选"
            aria-label="删除所选"
            disabled={!selectedNodeId && selectedEdgeIds.length === 0}
            onClick={deleteSelected}
          >
            <Trash2 aria-hidden="true" />
          </button>
        </div>
        <div className={`wasm-badge state-${wasmState}`}>
          <span />
          {wasmState === "ready" ? `WASM v${wasmVersion}` : "WASM"}
        </div>
      </header>

      <div className="workbench">
        <aside className="palette" aria-label="元件库">
          <div className="panel-title">
            <Plus aria-hidden="true" />
            <div>
              <strong>元件库</strong>
              <span>{catalog.length} COMPONENTS</span>
            </div>
          </div>
          {["source", "gate", "sink"].map((category) => (
            <section className="palette-group" key={category}>
              <h2>
                {category === "source"
                  ? "输入与常量"
                  : category === "sink"
                    ? "观测"
                    : "逻辑门"}
              </h2>
              {catalog
                .filter((descriptor) => descriptor.category === category)
                .map((descriptor) => {
                  const Icon = descriptorIcon(descriptor);
                  return (
                    <button
                      type="button"
                      className="palette-item"
                      key={descriptor.type_id}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(
                          "application/logsim-component",
                          descriptor.type_id,
                        );
                        event.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => addComponent(descriptor.type_id)}
                    >
                      <Icon aria-hidden="true" />
                      <span>
                        <strong>
                          {DISPLAY_NAMES[descriptor.type_id] ??
                            descriptor.display_name}
                        </strong>
                        <small>{descriptor.ports.length} PORTS</small>
                      </span>
                      <Plus aria-hidden="true" />
                    </button>
                  );
                })}
            </section>
          ))}
        </aside>

        <section
          className="canvas"
          aria-label="电路画布"
          ref={flowRef}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDrop={onDrop}
        >
          {catalog.length > 0 ? (
            <ReactFlow<EditorNode, EditorEdge>
              nodes={renderedNodes}
              edges={renderedEdges}
              nodeTypes={nodeTypes}
              onInit={(instance) => {
                instanceRef.current = instance;
              }}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onNodeClick={onNodeClick}
              onSelectionChange={onSelectionChange}
              onNodesDelete={(deleted) => {
                const ids = new Set(deleted.map((node) => node.id));
                setEdges((current) =>
                  current.filter(
                    (edge) => !ids.has(edge.source) && !ids.has(edge.target),
                  ),
                );
                setSelectedNodeId(null);
              }}
              deleteKeyCode={["Backspace", "Delete"]}
              fitView
              fitViewOptions={{ padding: 0.28 }}
              minZoom={0.25}
              maxZoom={2}
              snapToGrid
              snapGrid={[16, 16]}
              defaultEdgeOptions={{ type: "smoothstep" }}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color="#bcc6cc"
              />
            </ReactFlow>
          ) : (
            <div className="canvas-loading">
              <Activity aria-hidden="true" />
              <strong>正在初始化 Rust/WASM</strong>
            </div>
          )}
          {nodes.length === 0 && (
            <div className="empty-canvas">
              <MousePointer2 aria-hidden="true" />
              <strong>从左侧添加元件</strong>
            </div>
          )}
        </section>

        <aside className="inspector" aria-label="检查器">
          <div className="panel-title">
            <Activity aria-hidden="true" />
            <div>
              <strong>检查器</strong>
              <span>RUST SNAPSHOT</span>
            </div>
          </div>
          {selectedNode && selectedDescriptor ? (
            <NodeInspector
              node={selectedNode}
              descriptor={selectedDescriptor}
              snapshot={snapshot}
            />
          ) : (
            <ExampleHelp />
          )}
          <Diagnostics snapshot={snapshot} />
        </aside>
      </div>

      <footer className="statusbar">
        <span className={`status-dot state-${wasmState}`} />
        <strong>{statusMessage}</strong>
        <span className="status-separator" />
        <span>
          {snapshot
            ? snapshot.stable
              ? "STABLE"
              : "UNSTABLE"
            : "NO SNAPSHOT"}
        </span>
        <span>{snapshot?.processed_events ?? 0} EVENTS</span>
        <span>{snapshot?.diagnostics.length ?? 0} DIAGNOSTICS</span>
        <span className="status-spacer" />
        <span>{nodes.length} NODES</span>
        <span>{edges.length} WIRES</span>
      </footer>
    </main>
  );
}

function ExampleHelp() {
  return (
    <section className="inspector-section example-help">
      <h2>默认示例</h2>
      <div className="example-path">
        <span>INPUT 0</span>
        <b>→</b>
        <span>NEG</span>
        <b>→</b>
        <span>PROBE</span>
      </div>
      <p>
        点击画布中的 Trit Input，输入会按 <b>T → 0 → 1 → T</b>{" "}
        循环，并立即调用 Rust/WASM 模拟器。
      </p>
      <dl className="ternary-key">
        <div>
          <dt className="signal-T">T</dt>
          <dd>−1，负一</dd>
        </div>
        <div>
          <dt className="signal-0">0</dt>
          <dd>0，中性值</dd>
        </div>
        <div>
          <dt className="signal-1">1</dt>
          <dd>+1，正一</dd>
        </div>
      </dl>
      <p>
        NEG 执行平衡三进制取反，因此 T 变为 1，0 保持 0，1 变为 T。
        X、Z、E 分别表示未知、高阻和错误；所有门值均来自模拟器快照。
      </p>
    </section>
  );
}

function SignalRows({
  title,
  values,
}: {
  title: string;
  values: Record<string, TritSymbol>;
}) {
  return (
    <div className="signal-group">
      <h3>{title}</h3>
      {Object.keys(values).length === 0 ? (
        <span className="muted">无端口</span>
      ) : (
        Object.entries(values).map(([port, value]) => (
          <div className="signal-row" key={port}>
            <code>{port}</code>
            <strong
              className={`signal-${value}`}
              style={{ color: SIGNAL_COLORS[value] }}
            >
              {value}
            </strong>
          </div>
        ))
      )}
    </div>
  );
}

function NodeInspector({
  node,
  descriptor,
  snapshot,
}: {
  node: EditorNode;
  descriptor: CatalogComponent;
  snapshot: SimulationSnapshot | null;
}) {
  const inputValues = snapshot?.input_nets[node.id] ?? {};
  const outputValues = snapshot?.component_outputs[node.id] ?? {};
  const inputPorts = descriptor.ports.filter(
    (port) => port.direction === "input",
  );
  const outputPorts = descriptor.ports.filter(
    (port) => port.direction === "output",
  );

  return (
    <>
      <section className="inspector-section selected-component">
        <span className="type-chip">{descriptor.category.toUpperCase()}</span>
        <h2>{DISPLAY_NAMES[descriptor.type_id] ?? descriptor.display_name}</h2>
        <dl className="metadata">
          <div>
            <dt>稳定 ID</dt>
            <dd>{node.id}</dd>
          </div>
          <div>
            <dt>类型</dt>
            <dd>{descriptor.type_id}</dd>
          </div>
        </dl>
        <div className="signal-columns">
          <SignalRows title="输入" values={inputValues} />
          <SignalRows title="输出" values={outputValues} />
        </div>
      </section>
      {descriptor.category === "gate" && (
        <section className="inspector-section truth-table-section">
          <h2>真值表</h2>
          <div className="truth-table-wrap">
            <table>
              <thead>
                <tr>
                  {inputPorts.map((port) => (
                    <th key={port.id}>{port.id}</th>
                  ))}
                  {outputPorts.map((port) => (
                    <th className="output-column" key={port.id}>
                      {port.id}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {descriptor.truth_table.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {[...row.inputs, ...row.outputs].map((value, index) => (
                      <td
                        className={`signal-${value}`}
                        key={`${rowIndex}-${index}`}
                        style={{ color: SIGNAL_COLORS[value] }}
                      >
                        {value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function Diagnostics({
  snapshot,
}: {
  snapshot: SimulationSnapshot | null;
}) {
  const diagnostics = snapshot?.diagnostics ?? [];
  return (
    <section className="inspector-section diagnostics-section">
      <div className="section-heading">
        <h2>诊断</h2>
        <span>{diagnostics.length}</span>
      </div>
      {diagnostics.length === 0 ? (
        <p className="muted">当前没有诊断信息。</p>
      ) : (
        <ul>
          {diagnostics.map((diagnostic, index) => (
            <li
              className={`diagnostic diagnostic-${diagnostic.severity}`}
              key={`${diagnostic.code}-${index}`}
            >
              <strong>{diagnostic.code}</strong>
              <span>{diagnostic.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <Workbench />
    </ReactFlowProvider>
  );
}
