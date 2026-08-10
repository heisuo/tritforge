use std::mem::size_of;

use sim_core::project::{
    ProjectCircuit, ProjectCircuitKind, ProjectCircuitV3, ProjectComponent, ProjectConnection,
    ProjectDocument, ProjectDocumentV3, ProjectWire, QualifiedPortRef, WireEndpoint,
};
use sim_core::project_simulator::{ProjectSimulator, ProjectSnapshot};
use sim_core::simulator::ClockPhase;
use sim_core::trace::{TRACE_CAPACITY, TraceFrame, TraceFrameReason, TraceSignalRef, TraceWatch};
use sim_core::trit::Trit;

fn component(id: &str, type_id: &str, properties: serde_json::Value) -> ProjectComponent {
    ProjectComponent::new(id, type_id, properties).unwrap()
}

fn connection(
    id: &str,
    source_component_id: &str,
    source_port_id: &str,
    target_component_id: &str,
    target_port_id: &str,
) -> ProjectConnection {
    ProjectConnection {
        id: id.into(),
        source_component_id: source_component_id.into(),
        source_port_id: source_port_id.into(),
        target_component_id: target_component_id.into(),
        target_port_id: target_port_id.into(),
    }
}

fn circuit(
    id: &str,
    kind: ProjectCircuitKind,
    components: Vec<ProjectComponent>,
    connections: Vec<ProjectConnection>,
) -> ProjectCircuit {
    ProjectCircuit {
        id: id.into(),
        name: id.into(),
        kind,
        components,
        connections,
    }
}

fn project(circuits: Vec<ProjectCircuit>) -> ProjectDocument {
    ProjectDocument {
        format: "logsim-ternary".into(),
        version: 2,
        root_circuit_id: "main".into(),
        circuits,
    }
}

fn endpoint(component_id: &str, port_id: &str) -> WireEndpoint {
    WireEndpoint {
        component_id: component_id.into(),
        port_id: port_id.into(),
    }
}

fn wire(id: &str, component_a: &str, port_a: &str, component_b: &str, port_b: &str) -> ProjectWire {
    ProjectWire {
        id: id.into(),
        endpoint_a: endpoint(component_a, port_a),
        endpoint_b: endpoint(component_b, port_b),
    }
}

fn circuit_v3(
    id: &str,
    kind: ProjectCircuitKind,
    components: Vec<ProjectComponent>,
    wires: Vec<ProjectWire>,
) -> ProjectCircuitV3 {
    ProjectCircuitV3 {
        id: id.into(),
        name: id.into(),
        kind,
        components,
        wires,
    }
}

fn project_v3(circuits: Vec<ProjectCircuitV3>) -> ProjectDocumentV3 {
    ProjectDocumentV3 {
        format: "logsim-ternary".into(),
        version: 3,
        root_circuit_id: "main".into(),
        circuits,
    }
}

fn port(circuit_id: &str, path: &[&str], component_id: &str, port_id: &str) -> TraceSignalRef {
    TraceSignalRef::ComponentPort(QualifiedPortRef::new(
        circuit_id,
        path.iter().copied(),
        component_id,
        port_id,
    ))
}

fn watch(id: &str, signal: TraceSignalRef) -> TraceWatch {
    TraceWatch {
        id: id.into(),
        signal,
    }
}

fn scalar_clock_project() -> ProjectDocument {
    project(vec![
        circuit(
            "main",
            ProjectCircuitKind::Main,
            vec![
                component(
                    "input",
                    "source.trit_input",
                    serde_json::json!({"value": "0"}),
                ),
                component("clock", "source.clock", serde_json::json!({})),
                component("probe", "sink.probe", serde_json::json!({})),
            ],
            vec![connection("clock-probe", "clock", "out", "probe", "in")],
        ),
        circuit("spare", ProjectCircuitKind::Module, vec![], vec![]),
    ])
}

fn trace_values(frame: &TraceFrame) -> Vec<(&str, String)> {
    frame
        .values
        .iter()
        .map(|value| (value.watch_id.as_str(), value.value.to_string()))
        .collect()
}

#[test]
fn trace_contract_is_stable_compact_and_serializes_camel_case_reasons() {
    let watch = watch("clock", port("main", &[], "clock", "out"));
    let serialized = serde_json::to_value(&watch).unwrap();
    assert_eq!(serialized["id"], "clock");
    assert_eq!(serialized["signal"]["kind"], "componentPort");
    assert_eq!(serialized["signal"]["ref"]["circuitId"], "main");

    let reasons = [
        (TraceFrameReason::Load, "load"),
        (TraceFrameReason::InputChange, "inputChange"),
        (TraceFrameReason::ClockRise, "clockRise"),
        (TraceFrameReason::ClockFall, "clockFall"),
        (TraceFrameReason::Reset, "reset"),
        (TraceFrameReason::Fault, "fault"),
    ];
    for (reason, expected) in reasons {
        assert_eq!(serde_json::to_value(reason).unwrap(), expected);
    }

    assert_eq!(TRACE_CAPACITY, 512);
    assert!(size_of::<TraceFrame>() < size_of::<ProjectSnapshot>());
    let mut simulator = ProjectSimulator::load(scalar_clock_project(), "main").unwrap();
    simulator.set_trace_watches(vec![watch]).unwrap();
    let frame = &simulator.trace_frames()[0];
    let object = serde_json::to_value(frame)
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(
        object,
        ["clockPhase", "cycle", "diagnostics", "reason", "values"]
    );
}

#[test]
fn records_load_input_and_both_ordered_clock_phases() {
    let mut simulator = ProjectSimulator::load(scalar_clock_project(), "main").unwrap();
    simulator
        .set_trace_watches(vec![
            watch("input", port("main", &[], "input", "out")),
            watch("clock", port("main", &[], "clock", "out")),
        ])
        .unwrap();

    let load = &simulator.trace_frames()[0];
    assert_eq!(load.reason, TraceFrameReason::Load);
    assert_eq!(load.cycle, 0);
    assert_eq!(load.clock_phase, ClockPhase::LowStable);
    assert_eq!(
        trace_values(load),
        vec![("input", "0".into()), ("clock", "0".into())]
    );

    simulator.set_source("main", "input", Trit::Pos).unwrap();
    simulator.tick().unwrap();
    let frames = simulator.trace_frames();
    assert_eq!(
        frames.iter().map(|frame| frame.reason).collect::<Vec<_>>(),
        vec![
            TraceFrameReason::Load,
            TraceFrameReason::InputChange,
            TraceFrameReason::ClockRise,
            TraceFrameReason::ClockFall,
        ]
    );
    assert_eq!(
        (frames[2].cycle, frames[2].clock_phase),
        (0, ClockPhase::HighStable)
    );
    assert_eq!(
        (frames[3].cycle, frames[3].clock_phase),
        (1, ClockPhase::LowStable)
    );
    assert_eq!(trace_values(&frames[2])[1].1, "1");
    assert_eq!(trace_values(&frames[3])[1].1, "0");
}

#[test]
fn project_source_updates_append_input_change_but_unreachable_edits_keep_history() {
    let initial = scalar_clock_project();
    let mut simulator = ProjectSimulator::load(initial.clone(), "main").unwrap();
    simulator
        .set_trace_watches(vec![watch("input", port("main", &[], "input", "out"))])
        .unwrap();

    let mut changed_source = initial.clone();
    changed_source.circuits[0].components[0] = component(
        "input",
        "source.trit_input",
        serde_json::json!({"value": "T"}),
    );
    simulator.update_project(changed_source.clone()).unwrap();
    assert_eq!(simulator.trace_frames().len(), 2);
    assert_eq!(
        simulator.trace_frames()[1].reason,
        TraceFrameReason::InputChange
    );
    assert_eq!(trace_values(&simulator.trace_frames()[1])[0].1, "T");

    changed_source.circuits[1].components.push(component(
        "unused",
        "source.constant",
        serde_json::json!({"value": "1"}),
    ));
    simulator.update_project(changed_source).unwrap();
    assert_eq!(simulator.trace_frames().len(), 2);
}

#[test]
fn v3_word_source_updates_append_one_ms_first_input_change_frame() {
    let initial = project_v3(vec![circuit_v3(
        "main",
        ProjectCircuitKind::Main,
        vec![component(
            "word",
            "source.trit_input",
            serde_json::json!({"width": 3, "value": "1T0"}),
        )],
        vec![],
    )]);
    let mut simulator = ProjectSimulator::load_v3(initial.clone(), "main").unwrap();
    simulator
        .set_trace_watches(vec![watch("word", port("main", &[], "word", "out"))])
        .unwrap();

    let mut changed = initial;
    changed.circuits[0].components[0] = component(
        "word",
        "source.trit_input",
        serde_json::json!({"width": 3, "value": "T01"}),
    );
    simulator.update_project_v3(changed).unwrap();

    assert_eq!(simulator.trace_frames().len(), 2);
    assert_eq!(
        simulator.trace_frames()[1].reason,
        TraceFrameReason::InputChange
    );
    assert_eq!(
        trace_values(&simulator.trace_frames()[1]),
        vec![("word", "T01".into())]
    );
}

#[test]
fn reassembles_scalar_three_and_twenty_seven_trit_helper_words_ms_first() {
    let wide = "10T10T10T10T10T10T10T10T10T";
    assert_eq!(wide.len(), 27);
    let project = project_v3(vec![circuit_v3(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "scalar",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            component(
                "word",
                "source.trit_input",
                serde_json::json!({"width": 3, "value": "1T0"}),
            ),
            component(
                "near",
                "wiring.tunnel",
                serde_json::json!({"width": 3, "label": "DATA"}),
            ),
            component(
                "far",
                "wiring.tunnel",
                serde_json::json!({"width": 3, "label": "DATA"}),
            ),
            component(
                "wide",
                "source.constant",
                serde_json::json!({"width": 27, "value": wide}),
            ),
        ],
        vec![wire("word-near", "word", "out", "near", "net")],
    )]);
    let mut simulator = ProjectSimulator::load_v3(project, "main").unwrap();
    simulator
        .set_trace_watches(vec![
            watch("scalar", port("main", &[], "scalar", "out")),
            watch("tunnel", port("main", &[], "far", "net")),
            watch("wide", port("main", &[], "wide", "out")),
        ])
        .unwrap();

    assert_eq!(
        trace_values(&simulator.trace_frames()[0]),
        vec![
            ("scalar", "T".into()),
            ("tunnel", "1T0".into()),
            ("wide", wide.into()),
        ]
    );
}

#[test]
fn qualified_nested_watches_keep_sibling_instances_isolated() {
    let module = circuit_v3(
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
    let main = circuit_v3(
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
            component(
                "left",
                "project.module_instance",
                serde_json::json!({"moduleId": "cell", "label": "Left"}),
            ),
            component(
                "right",
                "project.module_instance",
                serde_json::json!({"moduleId": "cell", "label": "Right"}),
            ),
        ],
        vec![
            wire("left-data", "left-source", "out", "left", "data"),
            wire("right-data", "right-source", "out", "right", "data"),
        ],
    );
    let mut simulator = ProjectSimulator::load_v3(project_v3(vec![main, module]), "main").unwrap();
    simulator
        .set_trace_watches(vec![
            watch("left", port("cell", &["left"], "probe", "in")),
            watch("right", port("cell", &["right"], "probe", "in")),
        ])
        .unwrap();

    assert_eq!(
        trace_values(&simulator.trace_frames()[0]),
        vec![("left", "1T0".into()), ("right", "T01".into())]
    );
}

#[test]
fn replacing_watches_reorders_values_and_removing_a_watch_is_deterministic() {
    let mut simulator = ProjectSimulator::load(scalar_clock_project(), "main").unwrap();
    let input = watch("input", port("main", &[], "input", "out"));
    let clock = watch("clock", port("main", &[], "clock", "out"));
    simulator
        .set_trace_watches(vec![input.clone(), clock.clone()])
        .unwrap();
    simulator
        .set_trace_watches(vec![clock.clone(), input.clone()])
        .unwrap();
    assert_eq!(
        trace_values(&simulator.trace_frames()[0])
            .into_iter()
            .map(|(id, _)| id)
            .collect::<Vec<_>>(),
        vec!["clock", "input"]
    );
    simulator.set_trace_watches(vec![input]).unwrap();
    assert_eq!(simulator.trace_watches().len(), 1);
    assert_eq!(simulator.trace_frames().len(), 1);
    assert_eq!(simulator.trace_frames()[0].values[0].watch_id, "input");
}

#[test]
fn evicts_exactly_the_oldest_frame_at_capacity_without_mutating_simulation() {
    let mut simulator = ProjectSimulator::load(scalar_clock_project(), "main").unwrap();
    simulator
        .set_trace_watches(vec![watch("input", port("main", &[], "input", "out"))])
        .unwrap();
    for index in 0..TRACE_CAPACITY {
        let value = if index % 2 == 0 { Trit::Pos } else { Trit::Neg };
        simulator.set_source("main", "input", value).unwrap();
    }
    assert_eq!(simulator.trace_frames().len(), TRACE_CAPACITY);
    assert!(
        simulator
            .trace_frames()
            .iter()
            .all(|frame| frame.reason == TraceFrameReason::InputChange)
    );

    let before = simulator.snapshot().unwrap();
    simulator.clear_trace();
    assert!(simulator.trace_frames().is_empty());
    assert_eq!(simulator.snapshot().unwrap(), before);
}

#[test]
fn reset_starts_new_history_and_reachable_recompile_removes_unavailable_watches() {
    let initial = scalar_clock_project();
    let mut simulator = ProjectSimulator::load(initial.clone(), "main").unwrap();
    simulator
        .set_trace_watches(vec![
            watch("input", port("main", &[], "input", "out")),
            watch("clock", port("main", &[], "clock", "out")),
        ])
        .unwrap();
    simulator.tick().unwrap();
    simulator.reset().unwrap();
    assert_eq!(simulator.trace_frames().len(), 1);
    assert_eq!(simulator.trace_frames()[0].reason, TraceFrameReason::Reset);
    assert_eq!(simulator.trace_frames()[0].cycle, 0);
    assert_eq!(
        simulator.trace_frames()[0].clock_phase,
        ClockPhase::LowStable
    );

    let mut rebuilt = initial;
    rebuilt.circuits[0]
        .components
        .retain(|component| component.id != "input");
    let snapshot = simulator.update_project(rebuilt).unwrap();
    assert_eq!(simulator.trace_watches().len(), 1);
    assert_eq!(simulator.trace_watches()[0].id, "clock");
    assert_eq!(simulator.trace_frames().len(), 1);
    assert_eq!(simulator.trace_frames()[0].reason, TraceFrameReason::Load);
    let unavailable = simulator.trace_diagnostics();
    assert_eq!(unavailable.len(), 1);
    assert_eq!(unavailable[0].code, "TRACE_SIGNAL_UNAVAILABLE");
    assert!(
        snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "TRACE_SIGNAL_UNAVAILABLE")
    );
}

#[test]
fn active_switch_clears_history_and_reports_removed_selections() {
    let mut simulator = ProjectSimulator::load(scalar_clock_project(), "main").unwrap();
    simulator
        .set_trace_watches(vec![watch("input", port("main", &[], "input", "out"))])
        .unwrap();
    simulator.tick().unwrap();

    let snapshot = simulator.switch_active("spare").unwrap();
    assert!(simulator.trace_watches().is_empty());
    assert!(simulator.trace_frames().is_empty());
    assert_eq!(
        simulator.trace_diagnostics()[0].code,
        "TRACE_SIGNAL_UNAVAILABLE"
    );
    assert!(
        snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "TRACE_SIGNAL_UNAVAILABLE")
    );
}

#[test]
fn source_and_phase_faults_are_retained_with_last_observable_values() {
    let mut simulator = ProjectSimulator::load(scalar_clock_project(), "main").unwrap();
    simulator
        .set_trace_watches(vec![watch("input", port("main", &[], "input", "out"))])
        .unwrap();

    let error = simulator
        .set_source("main", "input", Trit::Unknown)
        .unwrap_err();
    assert_eq!(error.code, "INVALID_SOURCE_UPDATE");
    let fault = simulator.trace_frames().back().unwrap();
    assert_eq!(fault.reason, TraceFrameReason::Fault);
    assert_eq!(trace_values(fault), vec![("input", "0".into())]);
    assert_eq!(fault.diagnostics[0].code, "INVALID_SOURCE_UPDATE");

    let mut invalid = scalar_clock_project();
    invalid.circuits[1].components.push(component(
        "invalid",
        "gate.not_real",
        serde_json::json!({}),
    ));
    simulator.update_project(invalid).unwrap_err();
    let unavailable = simulator.tick().unwrap_err();
    assert_eq!(unavailable.code, "PROJECT_NOT_READY");
    let fault = simulator.trace_frames().back().unwrap();
    assert_eq!(fault.reason, TraceFrameReason::Fault);
    assert_eq!(fault.cycle, 0);
    assert_eq!(fault.clock_phase, ClockPhase::LowStable);
    assert_eq!(fault.diagnostics[0].code, "PROJECT_NOT_READY");
    assert_eq!(trace_values(fault), vec![("input", "0".into())]);
}

#[test]
fn preserves_unknown_high_z_and_error_words_and_marks_unstable_snapshots_as_faults() {
    let helpers = project_v3(vec![circuit_v3(
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
    let mut simulator = ProjectSimulator::load_v3(helpers, "main").unwrap();
    simulator
        .set_trace_watches(vec![
            watch("conflict", port("main", &[], "conflict", "net")),
            watch("floating", port("main", &[], "floating", "net")),
        ])
        .unwrap();
    let load = &simulator.trace_frames()[0];
    assert_eq!(load.reason, TraceFrameReason::Fault);
    assert_eq!(
        trace_values(load),
        vec![("conflict", "EEE".into()), ("floating", "ZZZ".into())]
    );
    assert!(load.diagnostics.is_empty());

    let unknown_main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component("data", "source.constant", serde_json::json!({"value": "T"})),
            component(
                "selector",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            component("zero", "source.constant", serde_json::json!({"value": "0"})),
            component("unknown-source", "gate.mux2", serde_json::json!({})),
            component("mux", "gate.mux2", serde_json::json!({})),
        ],
        vec![
            connection("data-unknown-a", "data", "out", "unknown-source", "a"),
            connection("data-unknown-b", "data", "out", "unknown-source", "b"),
            connection("zero-unknown-s", "zero", "out", "unknown-source", "s"),
            connection("unknown-mux-a", "unknown-source", "y", "mux", "a"),
            connection("selector-mux-s", "selector", "out", "mux", "s"),
            connection("feedback", "mux", "y", "mux", "b"),
        ],
    );
    let mut unknown = ProjectSimulator::load(project(vec![unknown_main]), "main").unwrap();
    unknown
        .set_trace_watches(vec![watch(
            "unknown",
            port("main", &[], "unknown-source", "y"),
        )])
        .unwrap();
    assert_eq!(unknown.trace_frames()[0].reason, TraceFrameReason::Load);
    assert_eq!(
        trace_values(&unknown.trace_frames()[0]),
        vec![("unknown", "X".into())]
    );

    let oscillator = circuit(
        "oscillator",
        ProjectCircuitKind::Module,
        vec![
            component("data", "source.constant", serde_json::json!({"value": "T"})),
            component(
                "selector",
                "source.trit_input",
                serde_json::json!({"value": "T"}),
            ),
            component("mux", "gate.mux2", serde_json::json!({})),
            component("neg", "gate.neg", serde_json::json!({})),
        ],
        vec![
            connection("data-a", "data", "out", "mux", "a"),
            connection("selector-s", "selector", "out", "mux", "s"),
            connection("neg-b", "neg", "y", "mux", "b"),
            connection("mux-neg", "mux", "y", "neg", "a"),
        ],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![component(
            "cell",
            "project.module_instance",
            serde_json::json!({"moduleId": "oscillator", "label": "Cell"}),
        )],
        vec![],
    );
    let mut simulator = ProjectSimulator::load(project(vec![main, oscillator]), "main").unwrap();
    simulator
        .set_trace_watches(vec![watch(
            "unknown",
            port("oscillator", &["cell"], "mux", "y"),
        )])
        .unwrap();
    simulator
        .set_source("oscillator", "selector", Trit::Pos)
        .unwrap();
    let fault = simulator.trace_frames().back().unwrap();
    assert_eq!(fault.reason, TraceFrameReason::Fault);
    assert_eq!(trace_values(fault), vec![("unknown", "E".into())]);
    assert!(
        fault
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "NON_CONVERGENT_COMBINATIONAL_LOOP")
    );
}

#[test]
fn unavailable_watch_setup_is_transactional_and_keeps_the_previous_selection() {
    let mut simulator = ProjectSimulator::load(scalar_clock_project(), "main").unwrap();
    let current = watch("clock", port("main", &[], "clock", "out"));
    simulator.set_trace_watches(vec![current.clone()]).unwrap();
    let before = simulator.trace_frames().clone();

    let diagnostics = simulator
        .set_trace_watches(vec![watch("missing", port("main", &[], "missing", "out"))])
        .unwrap_err();
    assert_eq!(diagnostics[0].code, "TRACE_SIGNAL_UNAVAILABLE");
    assert_eq!(simulator.trace_watches(), &[current]);
    assert_eq!(simulator.trace_frames(), &before);
    assert_eq!(simulator.trace_diagnostics(), diagnostics);
}
