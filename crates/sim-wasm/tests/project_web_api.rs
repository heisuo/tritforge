use std::collections::BTreeMap;

use serde::Deserialize;
use sim_core::project::{
    ProjectCircuitKind, ProjectCircuitV3, ProjectComponent, ProjectDiagnostic, ProjectDocumentV3,
    ProjectWire, WireEndpoint,
};
use sim_core::project_simulator::{ProjectCompileMetrics, ProjectSnapshot};
use sim_core::simulator::ClockPhase;
use sim_core::trace::{
    MAX_TRACE_WATCHES, TRACE_CAPACITY, TraceFrame, TraceFrameReason, TraceSignalRef, TraceWatch,
};
use sim_core::trit::Trit;
use sim_wasm::{
    WasmProjectSimulator, resolve_project_module_interfaces, resolve_project_module_ports,
    resolve_project_ports,
};
use wasm_bindgen_test::wasm_bindgen_test;

fn component(id: &str, type_id: &str, properties: serde_json::Value) -> ProjectComponent {
    ProjectComponent::new(id, type_id, properties).unwrap()
}

fn module_instance(id: &str, module_id: &str) -> ProjectComponent {
    component(
        id,
        "project.module_instance",
        serde_json::json!({"moduleId": module_id, "label": id}),
    )
}

fn circuit(
    id: impl Into<String>,
    kind: ProjectCircuitKind,
    components: Vec<ProjectComponent>,
) -> ProjectCircuitV3 {
    let id = id.into();
    ProjectCircuitV3 {
        name: id.clone(),
        id,
        kind,
        components,
        wires: vec![],
    }
}

fn connected_circuit(
    id: impl Into<String>,
    kind: ProjectCircuitKind,
    components: Vec<ProjectComponent>,
    wires: Vec<ProjectWire>,
) -> ProjectCircuitV3 {
    let id = id.into();
    ProjectCircuitV3 {
        name: id.clone(),
        id,
        kind,
        components,
        wires,
    }
}

fn wire(
    id: &str,
    source_component_id: &str,
    source_port_id: &str,
    target_component_id: &str,
    target_port_id: &str,
) -> ProjectWire {
    ProjectWire {
        id: id.into(),
        endpoint_a: WireEndpoint {
            component_id: source_component_id.into(),
            port_id: source_port_id.into(),
        },
        endpoint_b: WireEndpoint {
            component_id: target_component_id.into(),
            port_id: target_port_id.into(),
        },
    }
}

fn project(circuits: Vec<ProjectCircuitV3>) -> ProjectDocumentV3 {
    ProjectDocumentV3 {
        format: "logsim-ternary".into(),
        version: 3,
        root_circuit_id: "main".into(),
        circuits,
    }
}

fn js_project(project: &ProjectDocumentV3) -> wasm_bindgen::JsValue {
    serde_wasm_bindgen::to_value(project).expect("serialize project")
}

fn trace_watch(
    id: &str,
    circuit_id: &str,
    instance_path: &[&str],
    component_id: &str,
    port_id: &str,
) -> TraceWatch {
    TraceWatch {
        id: id.into(),
        signal: TraceSignalRef::ComponentPort(sim_core::project::QualifiedPortRef::new(
            circuit_id,
            instance_path.iter().copied(),
            component_id,
            port_id,
        )),
    }
}

fn js_watches(watches: &[TraceWatch]) -> wasm_bindgen::JsValue {
    serde_wasm_bindgen::to_value(watches).expect("serialize trace watches")
}

fn trace_frames(simulator: &WasmProjectSimulator) -> Vec<TraceFrame> {
    serde_wasm_bindgen::from_value(simulator.trace_frames().expect("query trace frames"))
        .expect("deserialize trace frames")
}

fn trace_watches(simulator: &WasmProjectSimulator) -> Vec<TraceWatch> {
    serde_wasm_bindgen::from_value(simulator.trace_watches().expect("query trace watches"))
        .expect("deserialize trace watches")
}

fn sequential_project() -> ProjectDocumentV3 {
    let main = connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component("data", "source.constant", serde_json::json!({"value": "1"})),
            component(
                "enable",
                "source.constant",
                serde_json::json!({"value": "1"}),
            ),
            component(
                "reset",
                "source.constant",
                serde_json::json!({"value": "0"}),
            ),
            component("clock", "source.clock", serde_json::json!({})),
            component("dff", "sequential.dff", serde_json::json!({})),
        ],
        vec![
            wire("data-dff", "data", "out", "dff", "d"),
            wire("enable-dff", "enable", "out", "dff", "en"),
            wire("reset-dff", "reset", "out", "dff", "rst"),
            wire("clock-dff", "clock", "out", "dff", "clk"),
        ],
    );
    project(vec![main])
}

#[wasm_bindgen_test]
fn project_handle_loads_updates_and_switches_active_roots() {
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![module_instance("spare-1", "spare")],
    );
    let spare = circuit(
        "spare",
        ProjectCircuitKind::Module,
        vec![component(
            "constant",
            "source.constant",
            serde_json::json!({"value": "0"}),
        )],
    );
    let project = project(vec![main, spare]);
    let mut simulator = WasmProjectSimulator::new();

    let first: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .load_project(js_project(&project), "main")
            .expect("load project"),
    )
    .unwrap();
    let second: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .set_source("spare", "constant", "1")
            .expect("set shared source"),
    )
    .unwrap();
    let third: ProjectSnapshot =
        serde_wasm_bindgen::from_value(simulator.switch_active("spare").expect("preview module"))
            .unwrap();

    assert_eq!(first.compile_count, 1);
    assert_eq!(second.compile_count, 1);
    assert_eq!(third.compile_count, 2);
    let metrics: ProjectCompileMetrics =
        serde_wasm_bindgen::from_value(simulator.metrics().expect("compiled project metrics"))
            .unwrap();
    assert_eq!(metrics.expanded_components, 1);
}

#[wasm_bindgen_test]
fn project_handle_ticks_and_projects_dff_state() {
    let project = sequential_project();
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project), "main")
        .expect("load project");

    let snapshot: ProjectSnapshot =
        serde_wasm_bindgen::from_value(simulator.tick().expect("tick project"))
            .expect("deserialize project snapshot");

    assert_eq!(snapshot.component_outputs["dff"]["q"], Trit::Pos);
    assert_eq!(snapshot.component_output_words["dff"]["q"].to_string(), "1");
    assert_eq!(snapshot.component_outputs["clock"]["out"], Trit::Zero);
    assert_eq!(snapshot.input_nets["dff"]["clk"], Trit::Zero);
    assert_eq!(snapshot.input_net_words["dff"]["clk"].to_string(), "0");
    assert_eq!(snapshot.tick_count, 1);
}

#[wasm_bindgen_test]
fn project_phase_and_trace_api_preserves_ms_first_scalar_and_word_values() {
    let project = project(vec![connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component("clock", "source.clock", serde_json::json!({})),
            component(
                "word",
                "source.trit_input",
                serde_json::json!({"width": 3, "value": "1T0"}),
            ),
        ],
        vec![],
    )]);
    let mut simulator = WasmProjectSimulator::new();
    let initial: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .load_project(js_project(&project), "main")
            .expect("load project"),
    )
    .unwrap();
    assert_eq!(initial.clock_phase, ClockPhase::LowStable);

    simulator
        .set_trace_watches(js_watches(&[
            trace_watch("clock", "main", &[], "clock", "out"),
            trace_watch("word", "main", &[], "word", "out"),
        ]))
        .expect("watch scalar and word");
    let load = trace_frames(&simulator);
    assert_eq!(load.len(), 1);
    assert_eq!(load[0].reason, TraceFrameReason::Load);
    assert_eq!(load[0].clock_phase, ClockPhase::LowStable);
    assert_eq!(load[0].values[0].value.to_string(), "0");
    assert_eq!(load[0].values[1].value.to_string(), "1T0");

    let risen: ProjectSnapshot =
        serde_wasm_bindgen::from_value(simulator.advance_phase().expect("advance to high phase"))
            .unwrap();
    assert_eq!(risen.clock_phase, ClockPhase::HighStable);
    let fallen: ProjectSnapshot =
        serde_wasm_bindgen::from_value(simulator.advance_phase().expect("advance to low phase"))
            .unwrap();
    assert_eq!(fallen.clock_phase, ClockPhase::LowStable);
    assert_eq!(fallen.tick_count, 1);
    let frames = trace_frames(&simulator);
    assert_eq!(frames[1].reason, TraceFrameReason::ClockRise);
    assert_eq!(frames[2].reason, TraceFrameReason::ClockFall);

    let ticked: ProjectSnapshot =
        serde_wasm_bindgen::from_value(simulator.tick().expect("complete tick")).unwrap();
    assert_eq!(ticked.clock_phase, ClockPhase::LowStable);
    assert_eq!(ticked.tick_count, 2);
    let frames = trace_frames(&simulator);
    assert_eq!(frames[3].reason, TraceFrameReason::ClockRise);
    assert_eq!(frames[4].reason, TraceFrameReason::ClockFall);
}

#[wasm_bindgen_test]
fn project_trace_watch_replacement_history_clear_and_reset_are_stable() {
    let project = project(vec![connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "left",
                "source.trit_input",
                serde_json::json!({"value": "0"}),
            ),
            component(
                "right",
                "source.trit_input",
                serde_json::json!({"value": "1"}),
            ),
        ],
        vec![],
    )]);
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project), "main")
        .expect("load project");
    let left = trace_watch("left", "main", &[], "left", "out");
    let right = trace_watch("right", "main", &[], "right", "out");

    simulator
        .set_trace_watches(js_watches(&[left.clone(), right.clone()]))
        .unwrap();
    simulator
        .set_trace_watches(js_watches(&[right.clone(), left.clone()]))
        .unwrap();
    let frames = trace_frames(&simulator);
    assert_eq!(
        frames[0]
            .values
            .iter()
            .map(|value| value.watch_id.as_str())
            .collect::<Vec<_>>(),
        vec!["right", "left"]
    );
    simulator
        .set_trace_watches(js_watches(std::slice::from_ref(&left)))
        .unwrap();
    assert_eq!(trace_watches(&simulator), vec![left]);

    for index in 0..TRACE_CAPACITY {
        simulator
            .set_source("main", "left", if index % 2 == 0 { "1" } else { "T" })
            .unwrap();
    }
    assert_eq!(trace_frames(&simulator).len(), TRACE_CAPACITY);
    simulator.clear_trace().expect("clear trace");
    assert!(trace_frames(&simulator).is_empty());

    let reset: ProjectSnapshot =
        serde_wasm_bindgen::from_value(simulator.reset().expect("reset project")).unwrap();
    assert_eq!(reset.clock_phase, ClockPhase::LowStable);
    let frames = trace_frames(&simulator);
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].reason, TraceFrameReason::Reset);
}

#[wasm_bindgen_test]
fn project_reset_preserves_current_word_source_through_label_only_update() {
    let mut project = project(vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![component(
            "word",
            "source.trit_input",
            serde_json::json!({"width": 3, "value": "1T0", "label": "Before"}),
        )],
    )]);
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project), "main")
        .expect("load project");
    simulator
        .set_trace_watches(js_watches(&[trace_watch(
            "word",
            "main",
            &[],
            "word",
            "out",
        )]))
        .expect("watch word source");
    simulator
        .set_source("main", "word", "T01")
        .expect("update word source");

    let reset: ProjectSnapshot =
        serde_wasm_bindgen::from_value(simulator.reset().expect("reset project")).unwrap();
    assert_eq!(
        reset.component_output_words["word"]["out"].to_string(),
        "T01"
    );
    assert_eq!(reset.tick_count, 0);
    assert_eq!(reset.clock_phase, ClockPhase::LowStable);
    let frames = trace_frames(&simulator);
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].reason, TraceFrameReason::Reset);
    assert_eq!(frames[0].values[0].value.to_string(), "T01");

    project.circuits[0].components[0] = component(
        "word",
        "source.trit_input",
        serde_json::json!({"width": 3, "value": "T01", "label": "After"}),
    );
    let updated: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .update_project(js_project(&project))
            .expect("label-only update"),
    )
    .unwrap();
    assert_eq!(
        updated.component_output_words["word"]["out"].to_string(),
        "T01"
    );
    assert_eq!(trace_frames(&simulator), frames);
}

#[wasm_bindgen_test]
fn project_trace_nested_qualified_refs_preserve_instance_values() {
    let main = connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "left-source",
                "source.constant",
                serde_json::json!({"width": 3, "value": "1T0"}),
            ),
            component(
                "right-source",
                "source.constant",
                serde_json::json!({"width": 3, "value": "T01"}),
            ),
            module_instance("left", "cell"),
            module_instance("right", "cell"),
        ],
        vec![
            wire("left-data", "left-source", "out", "left", "data"),
            wire("right-data", "right-source", "out", "right", "data"),
        ],
    );
    let cell = connected_circuit(
        "cell",
        ProjectCircuitKind::Module,
        vec![
            component(
                "input",
                "project.module_input",
                serde_json::json!({
                    "portId": "data", "label": "Data", "width": 3, "previewValue": "000"
                }),
            ),
            component("probe", "sink.probe", serde_json::json!({"width": 3})),
        ],
        vec![wire("inside", "input", "out", "probe", "in")],
    );
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project(vec![main, cell])), "main")
        .unwrap();
    simulator
        .set_trace_watches(js_watches(&[
            trace_watch("left", "cell", &["left"], "probe", "in"),
            trace_watch("right", "cell", &["right"], "probe", "in"),
        ]))
        .unwrap();

    let frames = trace_frames(&simulator);
    assert_eq!(frames[0].values[0].value.to_string(), "1T0");
    assert_eq!(frames[0].values[1].value.to_string(), "T01");
}

#[wasm_bindgen_test]
fn invalid_trace_watch_replacements_are_structured_and_transactional() {
    let components = (0..=MAX_TRACE_WATCHES)
        .map(|index| {
            component(
                &format!("source-{index}"),
                "source.constant",
                serde_json::json!({"value": "0"}),
            )
        })
        .collect();
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(
            js_project(&project(vec![circuit(
                "main",
                ProjectCircuitKind::Main,
                components,
            )])),
            "main",
        )
        .unwrap();
    let original = trace_watch("original", "main", &[], "source-0", "out");
    simulator
        .set_trace_watches(js_watches(std::slice::from_ref(&original)))
        .unwrap();
    simulator.tick().unwrap();
    let frames_before = trace_frames(&simulator);

    let unavailable = trace_watch("missing", "main", &[], "missing", "out");
    let error = simulator
        .set_trace_watches(js_watches(&[unavailable]))
        .expect_err("unavailable watch must fail");
    let error: ProjectBoundaryErrorView = serde_wasm_bindgen::from_value(error).unwrap();
    assert_eq!(error.code, "TRACE_SIGNAL_UNAVAILABLE");
    assert_eq!(error.diagnostics[0].code, "TRACE_SIGNAL_UNAVAILABLE");
    assert_eq!(error.diagnostics[0].port_refs[0].component_id, "missing");
    let diagnostics: Vec<ProjectDiagnostic> = serde_wasm_bindgen::from_value(
        simulator
            .trace_diagnostics()
            .expect("query trace diagnostics"),
    )
    .unwrap();
    assert_eq!(diagnostics, error.diagnostics);
    assert_eq!(trace_watches(&simulator), vec![original.clone()]);
    assert_eq!(trace_frames(&simulator), frames_before);

    let error = simulator
        .set_trace_watches(wasm_bindgen::JsValue::from_str("not an array"))
        .expect_err("malformed watches must fail");
    let error: ProjectBoundaryErrorView = serde_wasm_bindgen::from_value(error).unwrap();
    assert_eq!(error.code, "INVALID_TRACE_WATCHES");
    assert!(error.diagnostics.is_empty());
    assert_eq!(trace_watches(&simulator), vec![original.clone()]);
    assert_eq!(trace_frames(&simulator), frames_before);

    let duplicate_id = vec![
        trace_watch("same", "main", &[], "source-1", "out"),
        trace_watch("same", "main", &[], "source-2", "out"),
    ];
    let error = simulator
        .set_trace_watches(js_watches(&duplicate_id))
        .expect_err("duplicate watch id must fail");
    let error: ProjectBoundaryErrorView = serde_wasm_bindgen::from_value(error).unwrap();
    assert_eq!(error.code, "DUPLICATE_TRACE_WATCH");
    assert_eq!(trace_watches(&simulator), vec![original.clone()]);
    assert_eq!(trace_frames(&simulator), frames_before);

    let duplicate = vec![
        trace_watch("first", "main", &[], "source-1", "out"),
        trace_watch("second", "main", &[], "source-1", "out"),
    ];
    let error = simulator
        .set_trace_watches(js_watches(&duplicate))
        .expect_err("duplicate signal must fail");
    let error: ProjectBoundaryErrorView = serde_wasm_bindgen::from_value(error).unwrap();
    assert_eq!(error.code, "DUPLICATE_TRACE_SIGNAL");
    assert_eq!(trace_watches(&simulator), vec![original.clone()]);
    assert_eq!(trace_frames(&simulator), frames_before);

    let over_limit = (0..=MAX_TRACE_WATCHES)
        .map(|index| {
            trace_watch(
                &format!("watch-{index}"),
                "main",
                &[],
                &format!("source-{index}"),
                "out",
            )
        })
        .collect::<Vec<_>>();
    let error = simulator
        .set_trace_watches(js_watches(&over_limit))
        .expect_err("watch limit must fail");
    let error: ProjectBoundaryErrorView = serde_wasm_bindgen::from_value(error).unwrap();
    assert_eq!(error.code, "TRACE_WATCH_LIMIT_EXCEEDED");
    assert_eq!(trace_watches(&simulator), vec![original]);
    assert_eq!(trace_frames(&simulator), frames_before);
}

#[wasm_bindgen_test]
fn trace_words_keep_high_impedance_and_error_symbols_across_wasm() {
    let project = project(vec![connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "negative",
                "source.constant",
                serde_json::json!({"width": 3, "value": "TTT"}),
            ),
            component(
                "positive",
                "source.constant",
                serde_json::json!({"width": 3, "value": "111"}),
            ),
            component(
                "conflict",
                "wiring.tunnel",
                serde_json::json!({"width": 3, "label": "CONFLICT"}),
            ),
            component(
                "floating",
                "wiring.tunnel",
                serde_json::json!({"width": 3, "label": "FLOATING"}),
            ),
        ],
        vec![
            wire("negative-conflict", "negative", "out", "conflict", "net"),
            wire("positive-conflict", "positive", "out", "conflict", "net"),
        ],
    )]);
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project), "main")
        .unwrap();
    simulator
        .set_trace_watches(js_watches(&[
            trace_watch("conflict", "main", &[], "conflict", "net"),
            trace_watch("floating", "main", &[], "floating", "net"),
        ]))
        .unwrap();

    let frame = trace_frames(&simulator).remove(0);
    assert_eq!(frame.reason, TraceFrameReason::Fault);
    assert_eq!(frame.values[0].value.to_string(), "EEE");
    assert_eq!(frame.values[1].value.to_string(), "ZZZ");
}

#[wasm_bindgen_test]
fn project_update_and_active_switch_follow_core_trace_lifecycle() {
    let initial = project(vec![
        circuit(
            "main",
            ProjectCircuitKind::Main,
            vec![component(
                "input",
                "source.trit_input",
                serde_json::json!({"value": "0", "label": "Input"}),
            )],
        ),
        circuit(
            "spare",
            ProjectCircuitKind::Module,
            vec![component(
                "spare-input",
                "source.trit_input",
                serde_json::json!({"value": "0"}),
            )],
        ),
    ]);
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&initial), "main")
        .unwrap();
    let watch = trace_watch("input", "main", &[], "input", "out");
    simulator
        .set_trace_watches(js_watches(std::slice::from_ref(&watch)))
        .unwrap();
    let before = trace_frames(&simulator);

    let mut unreachable_edit = initial;
    unreachable_edit.circuits[1].components[0] = component(
        "spare-input",
        "source.trit_input",
        serde_json::json!({"value": "0", "label": "Spare"}),
    );
    simulator
        .update_project(js_project(&unreachable_edit))
        .expect("unreachable edit preserves runtime trace");
    assert_eq!(trace_watches(&simulator), vec![watch]);
    assert_eq!(trace_frames(&simulator), before);

    let switched: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .switch_active("spare")
            .expect("switch active circuit"),
    )
    .unwrap();
    assert!(trace_watches(&simulator).is_empty());
    assert!(trace_frames(&simulator).is_empty());
    let diagnostics: Vec<ProjectDiagnostic> =
        serde_wasm_bindgen::from_value(simulator.trace_diagnostics().expect("trace diagnostics"))
            .unwrap();
    assert_eq!(diagnostics[0].code, "TRACE_SIGNAL_UNAVAILABLE");
    assert!(
        switched
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "TRACE_SIGNAL_UNAVAILABLE")
    );
}

#[wasm_bindgen_test]
fn boundary_fault_is_queryable_after_the_source_call_throws() {
    let project = project(vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![component(
            "input",
            "source.trit_input",
            serde_json::json!({"value": "0"}),
        )],
    )]);
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project), "main")
        .unwrap();
    simulator
        .set_trace_watches(js_watches(&[trace_watch(
            "input",
            "main",
            &[],
            "input",
            "out",
        )]))
        .unwrap();

    let error = simulator
        .set_source("main", "input", "X")
        .expect_err("meta-valued source update must fail");
    let error: ProjectBoundaryErrorView = serde_wasm_bindgen::from_value(error).unwrap();
    assert_eq!(error.code, "INVALID_TRIT_SYMBOL");
    assert_eq!(error.diagnostics[0].code, "INVALID_TRIT_SYMBOL");

    let frames = trace_frames(&simulator);
    let fault = frames.last().expect("fault frame remains queryable");
    assert_eq!(fault.reason, TraceFrameReason::Fault);
    assert_eq!(fault.values[0].value.to_string(), "0");
    assert_eq!(fault.diagnostics[0].code, "INVALID_TRIT_SYMBOL");
}

#[wasm_bindgen_test]
fn v3_words_load_and_update_most_significant_first() {
    let project = project(vec![connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "source",
                "source.trit_input",
                serde_json::json!({"width": 3, "value": "1T0"}),
            ),
            component("probe", "sink.probe", serde_json::json!({"width": 3})),
        ],
        vec![wire("word", "probe", "in", "source", "out")],
    )]);
    let mut simulator = WasmProjectSimulator::new();

    let loaded: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .load_project(js_project(&project), "main")
            .expect("load v3 project"),
    )
    .expect("deserialize word snapshot");
    let updated: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .set_source("main", "source", "T01")
            .expect("set width-three source"),
    )
    .expect("deserialize updated word snapshot");

    assert_eq!(
        loaded.component_output_words["source"]["out"].to_string(),
        "1T0"
    );
    assert_eq!(loaded.input_net_words["probe"]["in"].to_string(), "1T0");
    assert_eq!(
        updated.component_output_words["source"]["out"].to_string(),
        "T01"
    );
    assert_eq!(updated.input_net_words["probe"]["in"].to_string(), "T01");
    assert!(!updated.component_outputs.contains_key("source"));
    assert!(!updated.input_nets.contains_key("probe"));
}

#[wasm_bindgen_test]
fn word_projection_preserves_unknown_high_z_and_error_symbols() {
    let project = project(vec![connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "known-zero",
                "source.constant",
                serde_json::json!({"value": "0"}),
            ),
            component("unknown", "gate.min", serde_json::json!({})),
            component(
                "negative",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            component(
                "positive",
                "source.constant",
                serde_json::json!({"value": "1"}),
            ),
            component(
                "splitter",
                "wiring.splitter",
                serde_json::json!({
                    "width": 3,
                    "branchCount": 3,
                    "mapping": [0, 1, 2]
                }),
            ),
            component("probe", "sink.probe", serde_json::json!({"width": 3})),
        ],
        vec![
            wire("known-input", "known-zero", "out", "unknown", "a"),
            wire("unknown-bit", "unknown", "y", "splitter", "branch0"),
            wire("error-negative", "negative", "out", "splitter", "branch2"),
            wire("error-positive", "positive", "out", "splitter", "branch2"),
            wire("word", "splitter", "trunk", "probe", "in"),
        ],
    )]);

    let snapshot: ProjectSnapshot = serde_wasm_bindgen::from_value(
        WasmProjectSimulator::new()
            .load_project(js_project(&project), "main")
            .expect("load meta-word project"),
    )
    .unwrap();

    assert_eq!(snapshot.input_net_words["probe"]["in"].to_string(), "EZX");
    assert_eq!(
        snapshot.input_net_words["splitter"]["trunk"].to_string(),
        "EZX"
    );
}

#[wasm_bindgen_test]
fn v3_updates_preserve_dff_state_for_values_labels_and_unreachable_edits() {
    let mut project = sequential_project();
    project
        .circuits
        .push(circuit("spare", ProjectCircuitKind::Module, vec![]));
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project), "main")
        .expect("load sequential v3 project");
    let captured: ProjectSnapshot =
        serde_wasm_bindgen::from_value(simulator.tick().expect("capture data")).unwrap();
    assert_eq!(captured.component_outputs["dff"]["q"], Trit::Pos);

    project.circuits[0].components[0] =
        component("data", "source.constant", serde_json::json!({"value": "0"}));
    let value_edit: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .update_project(js_project(&project))
            .expect("update source value"),
    )
    .unwrap();

    project.circuits[0].components[4] = component(
        "dff",
        "sequential.dff",
        serde_json::json!({"label": "State"}),
    );
    let label_edit: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .update_project(js_project(&project))
            .expect("update display label"),
    )
    .unwrap();

    project.circuits[1].components.push(component(
        "unused",
        "source.constant",
        serde_json::json!({"value": "T"}),
    ));
    let unreachable_edit: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .update_project(js_project(&project))
            .expect("update unreachable module"),
    )
    .unwrap();

    for snapshot in [&value_edit, &label_edit, &unreachable_edit] {
        assert_eq!(snapshot.component_outputs["dff"]["q"], Trit::Pos);
        assert_eq!(snapshot.tick_count, 1);
        assert_eq!(snapshot.compile_count, 1);
    }
    let next: ProjectSnapshot =
        serde_wasm_bindgen::from_value(simulator.tick().expect("capture updated data")).unwrap();
    assert_eq!(next.component_outputs["dff"]["q"], Trit::Zero);
    assert_eq!(next.tick_count, 2);
    assert_eq!(next.compile_count, 1);
}

#[wasm_bindgen_test]
fn tunnel_word_projection_is_visible_without_exposing_lowered_bits() {
    let project = project(vec![connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "source",
                "source.constant",
                serde_json::json!({"width": 4, "value": "1T01"}),
            ),
            component(
                "near",
                "wiring.tunnel",
                serde_json::json!({"label": "DATA", "width": 4}),
            ),
            component(
                "far",
                "wiring.tunnel",
                serde_json::json!({"label": "DATA", "width": 4}),
            ),
            component("probe", "sink.probe", serde_json::json!({"width": 4})),
        ],
        vec![
            wire("near-segment", "source", "out", "near", "net"),
            wire("far-segment", "far", "net", "probe", "in"),
        ],
    )]);

    let snapshot: ProjectSnapshot = serde_wasm_bindgen::from_value(
        WasmProjectSimulator::new()
            .load_project(js_project(&project), "main")
            .expect("load tunnel project"),
    )
    .unwrap();

    assert_eq!(snapshot.input_net_words["near"]["net"].to_string(), "1T01");
    assert_eq!(snapshot.input_net_words["far"]["net"].to_string(), "1T01");
    assert_eq!(snapshot.input_net_words["probe"]["in"].to_string(), "1T01");
    assert!(
        snapshot
            .input_net_words
            .keys()
            .all(|id| !id.contains("#bit"))
    );
}

#[wasm_bindgen_test]
fn arbitrary_splitter_mapping_projects_logical_branch_words() {
    let project = project(vec![connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "source",
                "source.constant",
                serde_json::json!({"width": 4, "value": "1T01"}),
            ),
            component(
                "splitter",
                "wiring.splitter",
                serde_json::json!({
                    "width": 4,
                    "branchCount": 2,
                    "mapping": [1, 0, 1, 0]
                }),
            ),
            component("even", "sink.probe", serde_json::json!({"width": 2})),
            component("odd", "sink.probe", serde_json::json!({"width": 2})),
        ],
        vec![
            wire("trunk", "source", "out", "splitter", "trunk"),
            wire("even", "splitter", "branch0", "even", "in"),
            wire("odd", "splitter", "branch1", "odd", "in"),
        ],
    )]);

    let snapshot: ProjectSnapshot = serde_wasm_bindgen::from_value(
        WasmProjectSimulator::new()
            .load_project(js_project(&project), "main")
            .expect("load splitter project"),
    )
    .unwrap();

    assert_eq!(
        snapshot.input_net_words["splitter"]["trunk"].to_string(),
        "1T01"
    );
    assert_eq!(
        snapshot.input_net_words["splitter"]["branch0"].to_string(),
        "10"
    );
    assert_eq!(
        snapshot.input_net_words["splitter"]["branch1"].to_string(),
        "T1"
    );
    assert_eq!(snapshot.input_net_words["even"]["in"].to_string(), "10");
    assert_eq!(snapshot.input_net_words["odd"]["in"].to_string(), "T1");
}

#[wasm_bindgen_test]
fn three_level_nested_module_projection_preserves_the_word_interface() {
    let inner = connected_circuit(
        "inner",
        ProjectCircuitKind::Module,
        vec![
            component(
                "input",
                "project.module_input",
                serde_json::json!({
                    "portId": "data",
                    "label": "Data",
                    "width": 3,
                    "previewValue": "000"
                }),
            ),
            component(
                "output",
                "project.module_output",
                serde_json::json!({"portId": "result", "label": "Result", "width": 3}),
            ),
        ],
        vec![wire("pass", "input", "out", "output", "in")],
    );
    let outer = connected_circuit(
        "outer",
        ProjectCircuitKind::Module,
        vec![
            component(
                "input",
                "project.module_input",
                serde_json::json!({
                    "portId": "data",
                    "label": "Data",
                    "width": 3,
                    "previewValue": "000"
                }),
            ),
            module_instance("inner-instance", "inner"),
            component(
                "output",
                "project.module_output",
                serde_json::json!({"portId": "result", "label": "Result", "width": 3}),
            ),
        ],
        vec![
            wire("outer-in", "input", "out", "inner-instance", "data"),
            wire("outer-out", "inner-instance", "result", "output", "in"),
        ],
    );
    let main = connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "source",
                "source.constant",
                serde_json::json!({"width": 3, "value": "1T0"}),
            ),
            module_instance("outer-instance", "outer"),
            component("probe", "sink.probe", serde_json::json!({"width": 3})),
        ],
        vec![
            wire("main-in", "source", "out", "outer-instance", "data"),
            wire("main-out", "outer-instance", "result", "probe", "in"),
        ],
    );

    let snapshot: ProjectSnapshot = serde_wasm_bindgen::from_value(
        WasmProjectSimulator::new()
            .load_project(js_project(&project(vec![main, outer, inner])), "main")
            .expect("load three-level module project"),
    )
    .unwrap();

    assert_eq!(
        snapshot.input_net_words["outer-instance"]["data"].to_string(),
        "1T0"
    );
    assert_eq!(
        snapshot.component_output_words["outer-instance"]["result"].to_string(),
        "1T0"
    );
    assert_eq!(snapshot.input_net_words["probe"]["in"].to_string(), "1T0");
    assert!(
        snapshot
            .component_output_words
            .keys()
            .all(|id| !id.contains("#bit"))
    );
}

#[wasm_bindgen_test]
fn update_project_accepts_v3_wires_and_settles_word_values_without_recompiling() {
    let mut project = project(vec![connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "source",
                "source.constant",
                serde_json::json!({"width": 3, "value": "000"}),
            ),
            component("probe", "sink.probe", serde_json::json!({"width": 3})),
        ],
        vec![wire("word", "source", "out", "probe", "in")],
    )]);
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project), "main")
        .expect("load initial v3 project");
    project.circuits[0].components[0]
        .properties
        .set_known_word("value", "01T");

    let snapshot: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .update_project(js_project(&project))
            .expect("update v3 project"),
    )
    .unwrap();

    assert_eq!(snapshot.input_net_words["probe"]["in"].to_string(), "01T");
    assert_eq!(snapshot.compile_count, 1);
}

#[wasm_bindgen_test]
fn word_source_updates_every_flattened_module_copy() {
    let child = connected_circuit(
        "child",
        ProjectCircuitKind::Module,
        vec![
            component(
                "shared",
                "source.constant",
                serde_json::json!({"width": 3, "value": "000"}),
            ),
            component(
                "output",
                "project.module_output",
                serde_json::json!({"portId": "word", "label": "Word", "width": 3}),
            ),
        ],
        vec![wire("child-word", "shared", "out", "output", "in")],
    );
    let main = connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            module_instance("left", "child"),
            module_instance("right", "child"),
            component("left-probe", "sink.probe", serde_json::json!({"width": 3})),
            component("right-probe", "sink.probe", serde_json::json!({"width": 3})),
        ],
        vec![
            wire("left-word", "left", "word", "left-probe", "in"),
            wire("right-word", "right", "word", "right-probe", "in"),
        ],
    );
    let project = project(vec![main, child]);
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project), "main")
        .expect("load repeated module project");

    let snapshot: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .set_source("child", "shared", "1T0")
            .expect("update all repeated source copies"),
    )
    .unwrap();

    assert_eq!(
        snapshot.component_output_words["left"]["word"].to_string(),
        "1T0"
    );
    assert_eq!(
        snapshot.component_output_words["right"]["word"].to_string(),
        "1T0"
    );
    assert_eq!(
        snapshot.input_net_words["left-probe"]["in"].to_string(),
        "1T0"
    );
    assert_eq!(
        snapshot.input_net_words["right-probe"]["in"].to_string(),
        "1T0"
    );
}

#[wasm_bindgen_test]
fn set_source_validates_width_and_updates_module_input_preview() {
    let preview = connected_circuit(
        "preview",
        ProjectCircuitKind::Module,
        vec![
            component(
                "input",
                "project.module_input",
                serde_json::json!({
                    "portId": "data",
                    "label": "Data",
                    "width": 3,
                    "previewValue": "000"
                }),
            ),
            component("probe", "sink.probe", serde_json::json!({"width": 3})),
        ],
        vec![wire("preview", "input", "out", "probe", "in")],
    );
    let project = project(vec![
        circuit("main", ProjectCircuitKind::Main, vec![]),
        preview,
    ]);
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project), "preview")
        .expect("load module preview root");

    let error = simulator
        .set_source("preview", "input", "10")
        .expect_err("wrong width must fail");
    let error: ProjectBoundaryErrorView =
        serde_wasm_bindgen::from_value(error).expect("deserialize width error");
    let snapshot: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .set_source("preview", "input", "10T")
            .expect("update module preview"),
    )
    .expect("deserialize preview snapshot");

    assert_eq!(error.code, "INVALID_SIGNAL_WIDTH");
    assert_eq!(
        snapshot.component_output_words["input"]["out"].to_string(),
        "10T"
    );
    assert_eq!(snapshot.input_net_words["probe"]["in"].to_string(), "10T");
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedPortView {
    id: String,
    direction: String,
    width: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedModulePortView {
    id: String,
    label: String,
    direction: String,
    width: u8,
}

#[wasm_bindgen_test]
fn resolves_dynamic_ports_and_returns_structured_property_errors() {
    let properties = serde_wasm_bindgen::to_value(&serde_json::json!({
        "width": 3,
        "branchCount": 2,
        "mapping": [1, 0, 1]
    }))
    .unwrap();
    let ports: Vec<ResolvedPortView> = serde_wasm_bindgen::from_value(
        resolve_project_ports("wiring.splitter", properties).expect("resolve splitter"),
    )
    .unwrap();

    assert_eq!(
        ports
            .iter()
            .map(|port| (port.id.as_str(), port.direction.as_str(), port.width))
            .collect::<Vec<_>>(),
        vec![
            ("trunk", "inout", 3),
            ("branch0", "inout", 1),
            ("branch1", "inout", 2),
        ]
    );

    for (properties, expected) in [
        (serde_json::json!({"width": 0}), "INVALID_SIGNAL_WIDTH"),
        (
            serde_json::json!({"width": 3, "branchCount": 2, "mapping": [0, 2, 1]}),
            "INVALID_SPLITTER_MAP",
        ),
    ] {
        let error = resolve_project_ports(
            "wiring.splitter",
            serde_wasm_bindgen::to_value(&properties).unwrap(),
        )
        .expect_err("invalid dynamic property must fail");
        let error: ProjectBoundaryErrorView = serde_wasm_bindgen::from_value(error).unwrap();
        assert_eq!(error.code, expected);
    }
}

#[wasm_bindgen_test]
fn resolves_module_ports_from_the_validated_v3_interface_in_rust_id_order() {
    let module = circuit(
        "word-module",
        ProjectCircuitKind::Module,
        vec![
            component(
                "top-on-canvas",
                "project.module_output",
                serde_json::json!({"portId": "z-result", "label": "Z", "width": 2}),
            ),
            component(
                "bottom-on-canvas",
                "project.module_input",
                serde_json::json!({
                    "portId": "a-data",
                    "label": "A",
                    "width": 3,
                    "previewValue": "000"
                }),
            ),
        ],
    );
    let value = js_project(&project(vec![
        circuit("main", ProjectCircuitKind::Main, vec![]),
        module,
    ]));

    let ports: Vec<ResolvedModulePortView> = serde_wasm_bindgen::from_value(
        resolve_project_module_ports(value, "word-module").expect("resolve module interface"),
    )
    .unwrap();

    assert_eq!(
        ports
            .iter()
            .map(|port| (
                port.id.as_str(),
                port.label.as_str(),
                port.direction.as_str(),
                port.width,
            ))
            .collect::<Vec<_>>(),
        vec![("a-data", "A", "input", 3), ("z-result", "Z", "output", 2),]
    );
    assert!(ports.iter().all(|port| !port.id.contains("#bit")));
}

#[wasm_bindgen_test]
fn resolves_all_module_interfaces_in_one_project_aware_call() {
    let alpha = circuit(
        "alpha",
        ProjectCircuitKind::Module,
        vec![component(
            "input",
            "project.module_input",
            serde_json::json!({
                "portId": "data",
                "label": "Data bus",
                "width": 3,
                "previewValue": "000"
            }),
        )],
    );
    let beta = circuit(
        "beta",
        ProjectCircuitKind::Module,
        vec![component(
            "output",
            "project.module_output",
            serde_json::json!({"portId": "result", "label": "Result bus", "width": 2}),
        )],
    );
    let value = js_project(&project(vec![
        circuit("main", ProjectCircuitKind::Main, vec![]),
        beta,
        alpha,
    ]));

    let interfaces: BTreeMap<String, Vec<ResolvedModulePortView>> = serde_wasm_bindgen::from_value(
        resolve_project_module_interfaces(value).expect("resolve project interfaces"),
    )
    .unwrap();

    assert_eq!(
        interfaces.keys().map(String::as_str).collect::<Vec<_>>(),
        ["alpha", "beta"]
    );
    assert_eq!(interfaces["alpha"][0].label, "Data bus");
    assert_eq!(interfaces["beta"][0].label, "Result bus");
}

#[wasm_bindgen_test]
fn project_aware_port_errors_are_structured_and_hide_lowered_ids() {
    let invalid = project(vec![
        circuit("main", ProjectCircuitKind::Main, vec![]),
        circuit(
            "broken",
            ProjectCircuitKind::Module,
            vec![component(
                "bad-input",
                "project.module_input",
                serde_json::json!({
                    "portId": "data",
                    "label": "Data",
                    "width": 0,
                    "previewValue": "0"
                }),
            )],
        ),
    ]);

    let error = resolve_project_module_ports(js_project(&invalid), "broken")
        .expect_err("invalid module interface must fail");
    let serialized = js_sys::JSON::stringify(&error)
        .unwrap()
        .as_string()
        .unwrap();
    let error: ProjectBoundaryErrorView = serde_wasm_bindgen::from_value(error).unwrap();

    assert_eq!(error.code, "INVALID_SIGNAL_WIDTH");
    assert_eq!(error.diagnostics[0].code, "INVALID_SIGNAL_WIDTH");
    assert!(!serialized.contains("#bit"));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectBoundaryErrorView {
    code: String,
    diagnostics: Vec<ProjectDiagnostic>,
}

#[wasm_bindgen_test]
fn tick_before_project_load_returns_a_structured_not_loaded_error() {
    let error = WasmProjectSimulator::new()
        .tick()
        .expect_err("tick before project load must fail");
    let error: ProjectBoundaryErrorView =
        serde_wasm_bindgen::from_value(error).expect("deserialize project boundary error");

    assert_eq!(error.code, "SIMULATOR_NOT_LOADED");
    assert!(error.diagnostics.is_empty());
}

#[wasm_bindgen_test]
fn invalid_v3_update_is_transactional_and_keeps_the_previous_runtime() {
    let project = sequential_project();
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project), "main")
        .expect("load project");
    let mut invalid = project;
    invalid.circuits[0].components.push(component(
        "invalid",
        "gate.not_real",
        serde_json::json!({}),
    ));
    simulator
        .update_project(js_project(&invalid))
        .expect_err("invalid project update must fail");

    let snapshot: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .tick()
            .expect("previous valid project remains operational"),
    )
    .expect("deserialize retained project snapshot");

    assert_eq!(snapshot.tick_count, 1);
    assert_eq!(snapshot.compile_count, 1);
}

#[wasm_bindgen_test]
fn dependency_cycles_return_structured_project_diagnostics() {
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![module_instance("a-1", "a")],
    );
    let a = circuit(
        "a",
        ProjectCircuitKind::Module,
        vec![module_instance("b-1", "b")],
    );
    let b = circuit(
        "b",
        ProjectCircuitKind::Module,
        vec![module_instance("a-1", "a")],
    );
    let error = WasmProjectSimulator::new()
        .load_project(js_project(&project(vec![main, a, b])), "main")
        .expect_err("dependency cycle must fail");
    let error: ProjectBoundaryErrorView = serde_wasm_bindgen::from_value(error).unwrap();

    assert_eq!(error.code, "MODULE_DEPENDENCY_CYCLE");
    assert_eq!(error.diagnostics[0].code, "MODULE_DEPENDENCY_CYCLE");
}

#[wasm_bindgen_test]
fn hierarchy_limits_return_structured_project_diagnostics() {
    let mut circuits = vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![module_instance("next", "module-00")],
    )];
    for index in 0..32 {
        let components = if index < 31 {
            vec![module_instance("next", &format!("module-{:02}", index + 1))]
        } else {
            vec![]
        };
        circuits.push(circuit(
            format!("module-{index:02}"),
            ProjectCircuitKind::Module,
            components,
        ));
    }
    let error = WasmProjectSimulator::new()
        .load_project(js_project(&project(circuits)), "main")
        .expect_err("depth 33 must fail");
    let error: ProjectBoundaryErrorView = serde_wasm_bindgen::from_value(error).unwrap();

    assert_eq!(error.code, "HIERARCHY_EXPANSION_LIMIT");
    assert_eq!(error.diagnostics[0].code, "HIERARCHY_EXPANSION_LIMIT");
}
