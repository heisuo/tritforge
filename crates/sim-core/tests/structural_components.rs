use sim_core::connectivity::compile_project_v3;
use sim_core::project::{
    ProjectCircuitKind, ProjectCircuitV3, ProjectComponent, ProjectDocumentV3, ProjectProperties,
    ProjectWire, QualifiedPortRef, WireEndpoint,
};
use sim_core::project_simulator::ProjectSimulator;
use sim_core::project_validation::resolve_project_ports;
use sim_core::trace::{TraceSignalRef, TraceWatch};
use sim_core::trit::Trit;

fn properties(value: serde_json::Value) -> ProjectProperties {
    ProjectProperties::from_value(value).expect("object properties")
}

fn component(id: &str, type_id: &str, properties: serde_json::Value) -> ProjectComponent {
    ProjectComponent::new(id, type_id, properties).expect("valid component DTO")
}

fn wire(
    id: &str,
    left_component: &str,
    left_port: &str,
    right_component: &str,
    right_port: &str,
) -> ProjectWire {
    ProjectWire {
        id: id.into(),
        endpoint_a: WireEndpoint {
            component_id: left_component.into(),
            port_id: left_port.into(),
        },
        endpoint_b: WireEndpoint {
            component_id: right_component.into(),
            port_id: right_port.into(),
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

fn register_project(width: u8, value: &str) -> ProjectDocumentV3 {
    project(vec![ProjectCircuitV3 {
        id: "main".into(),
        name: "Register".into(),
        kind: ProjectCircuitKind::Main,
        components: vec![
            component(
                "data",
                "source.trit_input",
                serde_json::json!({"value": value, "width": width}),
            ),
            component("clock", "source.clock", serde_json::json!({})),
            component(
                "enable",
                "source.trit_input",
                serde_json::json!({"value": "1"}),
            ),
            component(
                "reset",
                "source.trit_input",
                serde_json::json!({"value": "0"}),
            ),
            component(
                "register",
                "sequential.register",
                serde_json::json!({"label": "R", "width": width}),
            ),
            component("probe", "sink.probe", serde_json::json!({"width": width})),
        ],
        wires: vec![
            wire("data-register", "data", "out", "register", "d"),
            wire("clock-register", "clock", "out", "register", "clk"),
            wire("enable-register", "enable", "out", "register", "en"),
            wire("reset-register", "reset", "out", "register", "rst"),
            wire("register-probe", "register", "q", "probe", "in"),
        ],
    }])
}

fn dff_ids(project: &ProjectDocumentV3) -> Vec<String> {
    let compiled = compile_project_v3(project.clone(), "main").expect("register compiles");
    compiled
        .compiled
        .circuit
        .components
        .iter()
        .filter(|component| component.type_id == "sequential.dff")
        .map(|component| component.id.clone())
        .collect()
}

#[test]
fn register_ports_resolve_word_data_and_scalar_controls_for_all_supported_widths() {
    for width in [1, 3, 27] {
        let ports = resolve_project_ports(
            "sequential.register",
            &properties(serde_json::json!({"label": "R", "width": width})),
        )
        .expect("register ports resolve");
        let shapes = ports
            .iter()
            .map(|port| (port.id.as_str(), port.direction, port.shape.width()))
            .collect::<Vec<_>>();
        assert_eq!(
            shapes,
            vec![
                ("d", sim_core::catalog::PortDirection::Input, width),
                ("clk", sim_core::catalog::PortDirection::Input, 1),
                ("en", sim_core::catalog::PortDirection::Input, 1),
                ("rst", sim_core::catalog::PortDirection::Input, 1),
                ("q", sim_core::catalog::PortDirection::Output, width),
            ]
        );
    }
}

#[test]
fn register_expands_to_exactly_one_existing_dff_per_trit_with_shared_controls() {
    for (width, value) in [(1, "1"), (3, "1T0"), (27, "000000000000000000000000000")] {
        let compiled =
            compile_project_v3(register_project(width, value), "main").expect("register compiles");
        let dffs = compiled
            .lowered
            .project
            .circuits
            .iter()
            .find(|circuit| circuit.id == "main")
            .expect("main circuit")
            .components
            .iter()
            .filter(|component| component.type_id == "sequential.dff")
            .collect::<Vec<_>>();
        assert_eq!(dffs.len(), usize::from(width));

        let connections = &compiled
            .lowered
            .project
            .circuits
            .iter()
            .find(|circuit| circuit.id == "main")
            .expect("main circuit")
            .connections;
        for dff in dffs {
            for port in ["d", "clk", "en", "rst"] {
                assert!(
                    connections.iter().any(|connection| {
                        connection.target_component_id == dff.id
                            && connection.target_port_id == port
                    }),
                    "{} must drive {}.{port}",
                    if port == "d" {
                        "one data bit"
                    } else {
                        "shared control"
                    },
                    dff.id
                );
            }
        }
    }
}

#[test]
fn register_captures_all_lanes_together_then_holds_and_reset_wins_over_enable() {
    let mut simulator = ProjectSimulator::load_v3(register_project(3, "1T0"), "main")
        .expect("register simulation loads");
    simulator
        .set_trace_watches(vec![TraceWatch {
            id: "register-q".into(),
            signal: TraceSignalRef::ComponentPort(QualifiedPortRef::new(
                "main",
                [] as [&str; 0],
                "register",
                "q",
            )),
        }])
        .expect("macro output is directly watchable");

    let captured = simulator.tick().expect("capture tick");
    assert_eq!(
        captured.component_output_words["register"]["q"].to_string(),
        "1T0"
    );
    assert_eq!(captured.input_net_words["probe"]["in"].to_string(), "1T0");
    assert_eq!(
        simulator
            .trace_frames()
            .back()
            .expect("capture frame")
            .values[0]
            .value
            .to_string(),
        "1T0"
    );

    simulator
        .set_source_word("main", "enable", "0")
        .expect("disable");
    simulator
        .set_source_word("main", "data", "T11")
        .expect("change data");
    let held = simulator.tick().expect("hold tick");
    assert_eq!(
        held.component_output_words["register"]["q"].to_string(),
        "1T0"
    );

    simulator
        .set_source_word("main", "enable", "1")
        .expect("enable");
    simulator
        .set_source_word("main", "reset", "1")
        .expect("reset");
    let reset = simulator.tick().expect("reset tick");
    assert_eq!(
        reset.component_output_words["register"]["q"].to_string(),
        "000"
    );
}

#[test]
fn generated_register_ids_are_stable_and_deterministic() {
    let forward = register_project(3, "1T0");
    let mut permuted = forward.clone();
    permuted.circuits[0].components.reverse();
    permuted.circuits[0].wires.reverse();

    let first = dff_ids(&forward);
    assert_eq!(first, dff_ids(&forward));
    assert_eq!(first, dff_ids(&permuted));
    assert_eq!(first.len(), 3);
    assert!(first.iter().all(|id| id.contains("register")));
}

fn register_module() -> ProjectCircuitV3 {
    ProjectCircuitV3 {
        id: "register-module".into(),
        name: "Register Module".into(),
        kind: ProjectCircuitKind::Module,
        components: vec![
            component(
                "input-d",
                "project.module_input",
                serde_json::json!({"portId": "d", "label": "D", "previewValue": "000", "width": 3}),
            ),
            component(
                "input-clk",
                "project.module_input",
                serde_json::json!({"portId": "clk", "label": "CLK", "previewValue": "0"}),
            ),
            component(
                "input-en",
                "project.module_input",
                serde_json::json!({"portId": "en", "label": "EN", "previewValue": "1"}),
            ),
            component(
                "input-rst",
                "project.module_input",
                serde_json::json!({"portId": "rst", "label": "RST", "previewValue": "0"}),
            ),
            component(
                "word-register",
                "sequential.register",
                serde_json::json!({"width": 3}),
            ),
            component(
                "output-q",
                "project.module_output",
                serde_json::json!({"portId": "q", "label": "Q", "width": 3}),
            ),
        ],
        wires: vec![
            wire("d", "input-d", "out", "word-register", "d"),
            wire("clk", "input-clk", "out", "word-register", "clk"),
            wire("en", "input-en", "out", "word-register", "en"),
            wire("rst", "input-rst", "out", "word-register", "rst"),
            wire("q", "word-register", "q", "output-q", "in"),
        ],
    }
}

fn nested_register_project() -> ProjectDocumentV3 {
    let main = ProjectCircuitV3 {
        id: "main".into(),
        name: "Nested Registers".into(),
        kind: ProjectCircuitKind::Main,
        components: vec![
            component(
                "data-a",
                "source.trit_input",
                serde_json::json!({"value": "1T0", "width": 3}),
            ),
            component(
                "data-b",
                "source.trit_input",
                serde_json::json!({"value": "T01", "width": 3}),
            ),
            component("clock", "source.clock", serde_json::json!({})),
            component(
                "enable",
                "source.trit_input",
                serde_json::json!({"value": "1"}),
            ),
            component(
                "reset",
                "source.trit_input",
                serde_json::json!({"value": "0"}),
            ),
            component(
                "register-a",
                "project.module_instance",
                serde_json::json!({"moduleId": "register-module", "label": "A"}),
            ),
            component(
                "register-b",
                "project.module_instance",
                serde_json::json!({"moduleId": "register-module", "label": "B"}),
            ),
        ],
        wires: vec![
            wire("data-a", "data-a", "out", "register-a", "d"),
            wire("data-b", "data-b", "out", "register-b", "d"),
            wire("clock-a", "clock", "out", "register-a", "clk"),
            wire("clock-b", "clock", "out", "register-b", "clk"),
            wire("enable-a", "enable", "out", "register-a", "en"),
            wire("enable-b", "enable", "out", "register-b", "en"),
            wire("reset-a", "reset", "out", "register-a", "rst"),
            wire("reset-b", "reset", "out", "register-b", "rst"),
        ],
    };
    project(vec![main, register_module()])
}

#[test]
fn nested_register_instances_own_isolated_dffs_and_state() {
    let project = nested_register_project();
    let ids = dff_ids(&project);
    assert_eq!(ids.len(), 6);
    assert_eq!(
        ids.iter()
            .filter(|id| id.starts_with("register-a/"))
            .count(),
        3
    );
    assert_eq!(
        ids.iter()
            .filter(|id| id.starts_with("register-b/"))
            .count(),
        3
    );

    let mut simulator = ProjectSimulator::load_v3(project, "main").expect("nested simulation");
    let captured = simulator.tick().expect("parallel capture");
    assert_eq!(
        captured.component_output_words["register-a"]["q"].to_string(),
        "1T0"
    );
    assert_eq!(
        captured.component_output_words["register-b"]["q"].to_string(),
        "T01"
    );
}

#[test]
fn generated_dff_diagnostics_are_remapped_to_the_register_macro() {
    let mut project = register_project(3, "1T0");
    project.circuits[0].components.push(component(
        "other-enable",
        "source.trit_input",
        serde_json::json!({"value": "T"}),
    ));
    project.circuits[0].wires.push(wire(
        "conflicting-enable",
        "other-enable",
        "out",
        "register",
        "en",
    ));

    let simulator = ProjectSimulator::load_v3(project, "main").expect("conflict is simulatable");
    let snapshot = simulator.snapshot().expect("snapshot");
    let conflict = snapshot
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "MULTIPLE_DRIVER_CONFLICT")
        .expect("register conflict diagnostic");
    assert!(
        conflict
            .component_refs
            .iter()
            .any(|reference| reference.component_id == "register")
    );
    assert!(
        conflict
            .port_refs
            .iter()
            .any(|reference| reference.component_id == "register" && reference.port_id == "en")
    );
    assert!(
        conflict
            .component_refs
            .iter()
            .all(|reference| !reference.component_id.contains("dff"))
    );
}

#[test]
fn register_rejects_invalid_widths_and_preflights_generated_dffs_against_limits() {
    for width in [0, 28] {
        let error = resolve_project_ports(
            "sequential.register",
            &properties(serde_json::json!({"width": width})),
        )
        .expect_err("invalid width");
        assert_eq!(error.code(), "INVALID_SIGNAL_WIDTH");
    }

    let register_bank = ProjectCircuitV3 {
        id: "register-bank".into(),
        name: "Register Bank".into(),
        kind: ProjectCircuitKind::Module,
        components: (0..371)
            .map(|index| {
                component(
                    &format!("register-{index:03}"),
                    "sequential.register",
                    serde_json::json!({"width": 27}),
                )
            })
            .collect(),
        wires: vec![],
    };
    let main = ProjectCircuitV3 {
        id: "main".into(),
        name: "Limit".into(),
        kind: ProjectCircuitKind::Main,
        components: vec![component(
            "bank",
            "project.module_instance",
            serde_json::json!({"moduleId": "register-bank", "label": "Bank"}),
        )],
        wires: vec![],
    };
    let diagnostics = compile_project_v3(project(vec![main, register_bank]), "main")
        .expect_err("10017 generated DFFs exceed the expansion limit");
    let limit = diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "HIERARCHY_EXPANSION_LIMIT")
        .expect("expansion limit diagnostic");
    assert!(limit.message.contains("component"));
    assert_eq!(limit.component_refs.len(), 1);
    assert_eq!(limit.component_refs[0].circuit_id, "register-bank");
    assert_eq!(limit.component_refs[0].component_id, "register-370");
}

#[test]
fn register_known_values_remain_ternary_words() {
    let mut simulator =
        ProjectSimulator::load_v3(register_project(1, "T"), "main").expect("width-one register");
    let captured = simulator.tick().expect("capture");
    assert_eq!(captured.component_outputs["register"]["q"], Trit::Neg);
}
