use sim_core::connectivity::{
    CompiledProjectV3, QualifiedWireBitRef, compile_project_v3, lower_project_v3,
};
use sim_core::project::{
    ProjectCircuitKind, ProjectCircuitV3, ProjectComponent, ProjectDocumentV3, ProjectWire,
    QualifiedPortRef, WireEndpoint,
};
use sim_core::simulator::Simulator;
use sim_core::trit::{Trit, resolve_drivers};

fn component(id: &str, type_id: &str, properties: serde_json::Value) -> ProjectComponent {
    ProjectComponent::new(id, type_id, properties).unwrap()
}

fn endpoint(component_id: &str, port_id: &str) -> WireEndpoint {
    WireEndpoint {
        component_id: component_id.into(),
        port_id: port_id.into(),
    }
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
        endpoint_a: endpoint(left_component, left_port),
        endpoint_b: endpoint(right_component, right_port),
    }
}

fn circuit(
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

fn project(circuits: Vec<ProjectCircuitV3>) -> ProjectDocumentV3 {
    ProjectDocumentV3 {
        format: "logsim-ternary".into(),
        version: 3,
        root_circuit_id: "main".into(),
        circuits,
    }
}

fn direct_word_project() -> ProjectDocumentV3 {
    project(vec![circuit(
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
        vec![wire("data", "probe", "in", "source", "out")],
    )])
}

fn probe_word(result: &CompiledProjectV3, component_id: &str) -> Vec<Trit> {
    let simulator = Simulator::load(result.compiled.circuit.clone()).unwrap();
    let snapshot = simulator.snapshot();
    let logical = QualifiedPortRef::new("main", [] as [&str; 0], component_id, "in");
    result.reassembly.ports[&logical]
        .iter()
        .map(|bit| {
            let flat = bit.flat_endpoints.first().unwrap();
            snapshot
                .input_value(&flat.component_id, &flat.port_id)
                .unwrap()
        })
        .collect()
}

fn diagnostics(project: ProjectDocumentV3) -> Vec<sim_core::project::ProjectDiagnostic> {
    lower_project_v3(project).unwrap_err()
}

#[test]
fn lowers_undirected_width_three_wire_and_reassembles_in_lst_order() {
    let result = compile_project_v3(direct_word_project(), "main").unwrap();
    let simulator = Simulator::load(result.compiled.circuit.clone()).unwrap();
    let snapshot = simulator.snapshot();
    let logical_probe = QualifiedPortRef::new("main", [] as [&str; 0], "probe", "in");
    let bits = result.reassembly.ports.get(&logical_probe).unwrap();

    assert_eq!(bits.len(), 3);
    assert_eq!(
        bits.iter()
            .map(|bit| {
                let flat = bit.flat_endpoints.first().unwrap();
                snapshot
                    .input_value(&flat.component_id, &flat.port_id)
                    .unwrap()
            })
            .collect::<Vec<_>>(),
        vec![Trit::Zero, Trit::Neg, Trit::Pos]
    );
    assert_eq!(result.lowered.project.version, 2);
    assert_eq!(result.compiled.circuit.connections.len(), 3);
}

#[test]
fn lowering_is_invariant_to_component_wire_and_circuit_permutations() {
    let forward = direct_word_project();
    let mut reversed = forward.clone();
    reversed.circuits.reverse();
    for circuit in &mut reversed.circuits {
        circuit.components.reverse();
        circuit.wires.reverse();
        for wire in &mut circuit.wires {
            std::mem::swap(&mut wire.endpoint_a, &mut wire.endpoint_b);
        }
    }

    assert_eq!(
        lower_project_v3(forward).unwrap(),
        lower_project_v3(reversed).unwrap()
    );
}

#[test]
fn generated_flat_connections_retain_original_wire_provenance() {
    let result = compile_project_v3(direct_word_project(), "main").unwrap();
    assert_eq!(result.wire_provenance.len(), 3);
    assert!(result.wire_provenance.values().all(|wires| {
        wires.len() == 1
            && wires[0].circuit_id == "main"
            && wires[0].instance_path.is_empty()
            && wires[0].connection_id == "data"
    }));
}

#[test]
fn reverse_provenance_retains_empty_input_and_output_only_wire_bits() {
    let lowered = lower_project_v3(project(vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component("input-a", "sink.probe", serde_json::json!({"width": 2})),
            component("input-b", "sink.probe", serde_json::json!({"width": 2})),
            component(
                "output-a",
                "source.constant",
                serde_json::json!({"width": 2, "value": "10"}),
            ),
            component(
                "output-b",
                "source.constant",
                serde_json::json!({"width": 2, "value": "T0"}),
            ),
            component(
                "driven",
                "source.constant",
                serde_json::json!({"width": 2, "value": "01"}),
            ),
            component("read", "sink.probe", serde_json::json!({"width": 2})),
        ],
        vec![
            wire("inputs", "input-a", "in", "input-b", "in"),
            wire("outputs", "output-a", "out", "output-b", "out"),
            wire("ordinary", "driven", "out", "read", "in"),
        ],
    )]))
    .unwrap();

    for bit in 0..2 {
        let inputs = QualifiedWireBitRef::new("main", [] as [&str; 0], "inputs", bit);
        let outputs = QualifiedWireBitRef::new("main", [] as [&str; 0], "outputs", bit);
        let ordinary = QualifiedWireBitRef::new("main", [] as [&str; 0], "ordinary", bit);
        assert_eq!(lowered.provenance.wire_bits.get(&inputs), Some(&vec![]));
        assert_eq!(lowered.provenance.wire_bits.get(&outputs), Some(&vec![]));
        assert_eq!(lowered.provenance.wire_bits[&ordinary].len(), 1);
    }
}

#[test]
fn lowered_project_is_accepted_by_existing_scalar_validation_and_compilation() {
    let lowered = lower_project_v3(direct_word_project()).unwrap();
    let validated = sim_core::project_validation::validate_project(lowered.project).unwrap();
    sim_core::hierarchy::compile_project(&validated, "main").unwrap();
}

#[test]
fn shared_undirected_endpoint_fans_out_and_preserves_driver_resolution() {
    fn driven(values: &[&str]) -> ProjectDocumentV3 {
        let mut components = values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                component(
                    &format!("source-{index}"),
                    "source.constant",
                    serde_json::json!({"value": value}),
                )
            })
            .collect::<Vec<_>>();
        components.extend([
            component("left", "sink.probe", serde_json::json!({})),
            component("right", "sink.probe", serde_json::json!({})),
        ]);
        let mut wires = values
            .iter()
            .enumerate()
            .map(|(index, _)| {
                wire(
                    &format!("drive-{index}"),
                    &format!("source-{index}"),
                    "out",
                    "left",
                    "in",
                )
            })
            .collect::<Vec<_>>();
        wires.push(wire("fanout", "left", "in", "right", "in"));
        project(vec![circuit(
            "main",
            ProjectCircuitKind::Main,
            components,
            wires,
        )])
    }

    let same = compile_project_v3(driven(&["1", "1"]), "main").unwrap();
    assert_eq!(probe_word(&same, "left"), vec![Trit::Pos]);
    assert_eq!(probe_word(&same, "right"), vec![Trit::Pos]);
    assert_eq!(same.compiled.circuit.connections.len(), 4);

    let conflict = compile_project_v3(driven(&["1", "T"]), "main").unwrap();
    assert_eq!(probe_word(&conflict, "left"), vec![Trit::Error]);
    assert_eq!(probe_word(&conflict, "right"), vec![Trit::Error]);
}

#[test]
fn disconnected_tunnel_segments_merge_by_exact_local_label() {
    let result = compile_project_v3(
        project(vec![circuit(
            "main",
            ProjectCircuitKind::Main,
            vec![
                component(
                    "source",
                    "source.constant",
                    serde_json::json!({"value": "T"}),
                ),
                component(
                    "near",
                    "wiring.tunnel",
                    serde_json::json!({"label": "Data"}),
                ),
                component("far", "wiring.tunnel", serde_json::json!({"label": "Data"})),
                component(
                    "other",
                    "wiring.tunnel",
                    serde_json::json!({"label": "data"}),
                ),
                component("probe", "sink.probe", serde_json::json!({})),
                component("isolated", "sink.probe", serde_json::json!({})),
            ],
            vec![
                wire("near-wire", "source", "out", "near", "net"),
                wire("far-wire", "far", "net", "probe", "in"),
                wire("other-wire", "other", "net", "isolated", "in"),
            ],
        )]),
        "main",
    )
    .unwrap();

    assert_eq!(probe_word(&result, "probe"), vec![Trit::Neg]);
    assert_eq!(probe_word(&result, "isolated"), vec![Trit::HighZ]);
    assert!(
        result
            .compiled
            .circuit
            .components
            .iter()
            .all(|component| !component.type_id.starts_with("wiring."))
    );
}

#[test]
fn helper_bits_reassemble_from_compiled_driver_or_consumer_nets() {
    let result = compile_project_v3(
        project(vec![circuit(
            "main",
            ProjectCircuitKind::Main,
            vec![
                component(
                    "source",
                    "source.constant",
                    serde_json::json!({"value": "1"}),
                ),
                component(
                    "other-source",
                    "source.constant",
                    serde_json::json!({"value": "T"}),
                ),
                component("driven-junction", "wiring.junction", serde_json::json!({})),
                component(
                    "floating-junction",
                    "wiring.junction",
                    serde_json::json!({}),
                ),
                component("probe", "sink.probe", serde_json::json!({})),
                component(
                    "isolated-junction",
                    "wiring.junction",
                    serde_json::json!({}),
                ),
            ],
            vec![
                wire("driver-only", "source", "out", "driven-junction", "net"),
                wire(
                    "other-driver-only",
                    "other-source",
                    "out",
                    "driven-junction",
                    "net",
                ),
                wire("consumer-only", "floating-junction", "net", "probe", "in"),
            ],
        )]),
        "main",
    )
    .unwrap();
    let simulator = Simulator::load(result.compiled.circuit.clone()).unwrap();
    let snapshot = simulator.snapshot();

    let driven = QualifiedPortRef::new("main", [] as [&str; 0], "driven-junction", "net");
    let driven_bit = &result.reassembly.ports[&driven][0];
    assert_eq!(driven_bit.flat_endpoints.len(), 2);
    let driver_values = driven_bit
        .flat_endpoints
        .iter()
        .map(|driver| {
            snapshot
                .output_value(&driver.component_id, &driver.port_id)
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        resolve_drivers(&driver_values),
        Trit::Error,
        "consumer-free helpers must retain every driver"
    );

    let floating = QualifiedPortRef::new("main", [] as [&str; 0], "floating-junction", "net");
    let floating_bit = &result.reassembly.ports[&floating][0];
    assert_eq!(floating_bit.flat_endpoints.len(), 1);
    let consumer = &floating_bit.flat_endpoints[0];
    assert_eq!(
        snapshot.input_value(&consumer.component_id, &consumer.port_id),
        Some(Trit::HighZ)
    );

    let isolated = QualifiedPortRef::new("main", [] as [&str; 0], "isolated-junction", "net");
    let isolated_bit = &result.reassembly.ports[&isolated][0];
    let isolated_net = result
        .reassembly
        .nets
        .get(isolated_bit.scalar_net.as_ref().unwrap())
        .unwrap();
    assert!(isolated_bit.flat_endpoints.is_empty());
    assert!(isolated_net.flat_drivers.is_empty());
    assert_eq!(resolve_drivers(&[]), Trit::HighZ);
}

#[test]
fn same_tunnel_label_with_different_widths_is_rejected_atomically() {
    let errors = diagnostics(project(vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "narrow",
                "wiring.tunnel",
                serde_json::json!({"label": "bus", "width": 1}),
            ),
            component(
                "wide",
                "wiring.tunnel",
                serde_json::json!({"label": "bus", "width": 3}),
            ),
        ],
        vec![],
    )]));
    let conflict = errors
        .iter()
        .find(|error| error.code == "TUNNEL_WIDTH_CONFLICT")
        .unwrap();
    assert_eq!(conflict.port_refs.len(), 2);
}

#[test]
fn ordinary_wire_width_mismatch_reports_the_wire_and_both_ports() {
    let errors = diagnostics(project(vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "source",
                "source.constant",
                serde_json::json!({"width": 3, "value": "111"}),
            ),
            component("probe", "sink.probe", serde_json::json!({})),
        ],
        vec![wire("bad-width", "source", "out", "probe", "in")],
    )]));
    let mismatch = errors
        .iter()
        .find(|error| error.code == "WIDTH_MISMATCH")
        .unwrap();
    assert_eq!(mismatch.connection_refs[0].connection_id, "bad-width");
    assert_eq!(mismatch.port_refs.len(), 2);
}

#[test]
fn splitters_map_lst_first_bits_for_split_and_combine() {
    let split = compile_project_v3(
        project(vec![circuit(
            "main",
            ProjectCircuitKind::Main,
            vec![
                component(
                    "source",
                    "source.constant",
                    serde_json::json!({"width": 6, "value": "1T001T"}),
                ),
                component(
                    "splitter",
                    "wiring.splitter",
                    serde_json::json!({
                        "width": 6,
                        "branchCount": 3,
                        "mapping": [0, 0, 1, 1, 1, 2]
                    }),
                ),
                component("branch-0", "sink.probe", serde_json::json!({"width": 2})),
                component("branch-1", "sink.probe", serde_json::json!({"width": 3})),
                component("branch-2", "sink.probe", serde_json::json!({})),
            ],
            vec![
                wire("trunk", "source", "out", "splitter", "trunk"),
                wire("branch-0", "splitter", "branch0", "branch-0", "in"),
                wire("branch-1", "splitter", "branch1", "branch-1", "in"),
                wire("branch-2", "splitter", "branch2", "branch-2", "in"),
            ],
        )]),
        "main",
    )
    .unwrap();
    assert_eq!(probe_word(&split, "branch-0"), vec![Trit::Neg, Trit::Pos]);
    assert_eq!(
        probe_word(&split, "branch-1"),
        vec![Trit::Zero, Trit::Zero, Trit::Neg]
    );
    assert_eq!(probe_word(&split, "branch-2"), vec![Trit::Pos]);

    let combine = compile_project_v3(
        project(vec![circuit(
            "main",
            ProjectCircuitKind::Main,
            vec![
                component("a", "source.constant", serde_json::json!({"value": "T"})),
                component("b", "source.constant", serde_json::json!({"value": "0"})),
                component("c", "source.constant", serde_json::json!({"value": "1"})),
                component(
                    "splitter",
                    "wiring.splitter",
                    serde_json::json!({"width": 3, "branchCount": 3, "mapping": [0, 1, 2]}),
                ),
                component("probe", "sink.probe", serde_json::json!({"width": 3})),
            ],
            vec![
                wire("a", "a", "out", "splitter", "branch0"),
                wire("b", "b", "out", "splitter", "branch1"),
                wire("c", "c", "out", "splitter", "branch2"),
                wire("trunk", "splitter", "trunk", "probe", "in"),
            ],
        )]),
        "main",
    )
    .unwrap();
    assert_eq!(
        probe_word(&combine, "probe"),
        vec![Trit::Neg, Trit::Zero, Trit::Pos]
    );
}

#[test]
fn malformed_endpoints_and_splitter_mapping_return_diagnostics_without_panicking() {
    let malformed = project(vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "bad-splitter",
                "wiring.splitter",
                serde_json::json!({"width": 3, "branchCount": 2, "mapping": [0, 2, "x"]}),
            ),
            component("probe", "sink.probe", serde_json::json!({})),
        ],
        vec![wire("missing", "ghost", "out", "probe", "missing-port")],
    )]);
    let outcome = std::panic::catch_unwind(|| lower_project_v3(malformed));
    let errors = outcome
        .expect("malformed input must not panic")
        .unwrap_err();
    let codes = errors
        .iter()
        .map(|error| error.code.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert!(codes.contains("INVALID_SPLITTER_MAP"));
    assert!(codes.contains("UNKNOWN_COMPONENT"));
    assert!(codes.contains("UNKNOWN_PORT"));
}

fn bus_passthrough_module() -> ProjectCircuitV3 {
    circuit(
        "bus-pass",
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
                "near",
                "wiring.tunnel",
                serde_json::json!({"label": "local", "width": 3}),
            ),
            component(
                "far",
                "wiring.tunnel",
                serde_json::json!({"label": "local", "width": 3}),
            ),
            component(
                "output",
                "project.module_output",
                serde_json::json!({"portId": "result", "label": "Result", "width": 3}),
            ),
        ],
        vec![
            wire("input-segment", "input", "out", "near", "net"),
            wire("output-segment", "far", "net", "output", "in"),
        ],
    )
}

#[test]
fn nested_width_three_module_instances_have_independent_tunnel_nets_and_projections() {
    let main = circuit(
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
                "left-instance",
                "project.module_instance",
                serde_json::json!({"moduleId": "bus-pass", "label": "Left"}),
            ),
            component(
                "right-instance",
                "project.module_instance",
                serde_json::json!({"moduleId": "bus-pass", "label": "Right"}),
            ),
            component("left-probe", "sink.probe", serde_json::json!({"width": 3})),
            component("right-probe", "sink.probe", serde_json::json!({"width": 3})),
        ],
        vec![
            wire("left-in", "left-source", "out", "left-instance", "data"),
            wire("left-out", "left-instance", "result", "left-probe", "in"),
            wire("right-in", "right-source", "out", "right-instance", "data"),
            wire("right-out", "right-instance", "result", "right-probe", "in"),
        ],
    );
    let result = compile_project_v3(project(vec![main, bus_passthrough_module()]), "main").unwrap();

    assert_eq!(
        probe_word(&result, "left-probe"),
        vec![Trit::Zero, Trit::Neg, Trit::Pos]
    );
    assert_eq!(
        probe_word(&result, "right-probe"),
        vec![Trit::Pos, Trit::Zero, Trit::Neg]
    );
    for instance in ["left-instance", "right-instance"] {
        let logical = QualifiedPortRef::new("main", [] as [&str; 0], instance, "result");
        assert_eq!(result.reassembly.ports[&logical].len(), 3);
        assert!(
            result.reassembly.ports[&logical]
                .iter()
                .all(|bit| !bit.flat_endpoints.is_empty())
        );

        let boundary = QualifiedPortRef::new("bus-pass", [instance], "output", "in");
        assert_eq!(result.reassembly.ports[&boundary].len(), 3);
        assert!(
            result.reassembly.ports[&boundary]
                .iter()
                .all(|bit| !bit.flat_endpoints.is_empty())
        );
    }
}

#[test]
fn three_level_bus_hierarchy_reassembles_qualified_helper_nets_per_outer_instance() {
    let outer = circuit(
        "outer",
        ProjectCircuitKind::Module,
        vec![
            component(
                "outer-input",
                "project.module_input",
                serde_json::json!({
                    "portId": "data",
                    "label": "Data",
                    "width": 3,
                    "previewValue": "000"
                }),
            ),
            component(
                "inner",
                "project.module_instance",
                serde_json::json!({"moduleId": "bus-pass", "label": "Inner"}),
            ),
            component(
                "outer-output",
                "project.module_output",
                serde_json::json!({"portId": "result", "label": "Result", "width": 3}),
            ),
        ],
        vec![
            wire("outer-in", "outer-input", "out", "inner", "data"),
            wire("outer-out", "inner", "result", "outer-output", "in"),
        ],
    );
    let main = circuit(
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
                "left-outer",
                "project.module_instance",
                serde_json::json!({"moduleId": "outer", "label": "Left"}),
            ),
            component(
                "right-outer",
                "project.module_instance",
                serde_json::json!({"moduleId": "outer", "label": "Right"}),
            ),
            component("left-probe", "sink.probe", serde_json::json!({"width": 3})),
            component("right-probe", "sink.probe", serde_json::json!({"width": 3})),
        ],
        vec![
            wire("left-in", "left-source", "out", "left-outer", "data"),
            wire("left-out", "left-outer", "result", "left-probe", "in"),
            wire("right-in", "right-source", "out", "right-outer", "data"),
            wire("right-out", "right-outer", "result", "right-probe", "in"),
        ],
    );
    let result =
        compile_project_v3(project(vec![main, outer, bus_passthrough_module()]), "main").unwrap();
    assert_eq!(
        probe_word(&result, "left-probe"),
        vec![Trit::Zero, Trit::Neg, Trit::Pos]
    );
    assert_eq!(
        probe_word(&result, "right-probe"),
        vec![Trit::Pos, Trit::Zero, Trit::Neg]
    );

    let left_tunnel = QualifiedPortRef::new("bus-pass", ["left-outer", "inner"], "near", "net");
    let right_tunnel = QualifiedPortRef::new("bus-pass", ["right-outer", "inner"], "near", "net");
    let left_bits = &result.reassembly.ports[&left_tunnel];
    let right_bits = &result.reassembly.ports[&right_tunnel];
    assert_eq!(left_bits.len(), 3);
    assert_eq!(right_bits.len(), 3);
    assert!(left_bits.iter().all(|bit| !bit.flat_endpoints.is_empty()));
    assert!(right_bits.iter().all(|bit| !bit.flat_endpoints.is_empty()));
    let left_components = left_bits
        .iter()
        .flat_map(|bit| bit.flat_endpoints.iter())
        .map(|endpoint| endpoint.component_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let right_components = right_bits
        .iter()
        .flat_map(|bit| bit.flat_endpoints.iter())
        .map(|endpoint| endpoint.component_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert!(left_components.is_disjoint(&right_components));
    assert!(
        left_bits
            .iter()
            .all(|bit| bit.scalar_net.as_ref().unwrap().instance_path == ["left-outer", "inner"])
    );
    let left_wire =
        QualifiedWireBitRef::new("bus-pass", ["left-outer", "inner"], "input-segment", 0);
    let right_wire =
        QualifiedWireBitRef::new("bus-pass", ["right-outer", "inner"], "input-segment", 0);
    assert!(!result.reverse_wire_provenance[&left_wire].is_empty());
    assert!(!result.reverse_wire_provenance[&right_wire].is_empty());
    assert_ne!(
        result.reverse_wire_provenance[&left_wire],
        result.reverse_wire_provenance[&right_wire]
    );
}

#[test]
fn generated_component_port_and_connection_ids_resist_user_collisions() {
    let collision_module = circuit(
        "collision-module",
        ProjectCircuitKind::Module,
        vec![
            component(
                "data-boundary",
                "project.module_input",
                serde_json::json!({
                    "portId": "data",
                    "label": "Data",
                    "width": 2,
                    "previewValue": "00"
                }),
            ),
            component(
                "colliding-port-boundary",
                "project.module_input",
                serde_json::json!({
                    "portId": "data#bit0",
                    "label": "Other",
                    "previewValue": "0"
                }),
            ),
        ],
        vec![],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "word",
                "source.constant",
                serde_json::json!({"width": 3, "value": "1T0"}),
            ),
            component("word#bit0", "gate.buf", serde_json::json!({})),
            component("word#bit0#", "gate.buf", serde_json::json!({})),
            component("word#bit1", "gate.buf", serde_json::json!({})),
            component("probe", "sink.probe", serde_json::json!({"width": 3})),
        ],
        vec![wire("v3-wire-00000", "word", "out", "probe", "in")],
    );
    let forward = project(vec![main, collision_module]);
    let mut reversed = forward.clone();
    for circuit in &mut reversed.circuits {
        circuit.components.reverse();
        circuit.wires.reverse();
    }
    let forward = lower_project_v3(forward).unwrap();
    let reversed = lower_project_v3(reversed).unwrap();
    assert_eq!(forward, reversed);
    for circuit in &forward.project.circuits {
        let ids = circuit
            .components
            .iter()
            .map(|component| component.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(ids.len(), circuit.components.len());
    }
    let connection_ids = forward.project.circuits[1]
        .connections
        .iter()
        .map(|connection| connection.id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(connection_ids.len(), 3);
    assert!(
        forward
            .provenance
            .connections
            .values()
            .flatten()
            .any(|wire| wire.connection_id == "v3-wire-00000")
    );
}

#[test]
fn non_contiguous_splitter_mapping_uses_ascending_trunk_order_per_branch() {
    let result = compile_project_v3(
        project(vec![circuit(
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
                component("branch-0", "sink.probe", serde_json::json!({"width": 2})),
                component("branch-1", "sink.probe", serde_json::json!({"width": 2})),
            ],
            vec![
                wire("trunk", "source", "out", "splitter", "trunk"),
                wire("branch-0", "splitter", "branch0", "branch-0", "in"),
                wire("branch-1", "splitter", "branch1", "branch-1", "in"),
            ],
        )]),
        "main",
    )
    .unwrap();
    assert_eq!(probe_word(&result, "branch-0"), vec![Trit::Zero, Trit::Pos]);
    assert_eq!(probe_word(&result, "branch-1"), vec![Trit::Pos, Trit::Neg]);
}

#[test]
fn duplicate_ids_and_module_cycles_are_structured_and_permutation_invariant() {
    let cyclic_a = circuit(
        "a",
        ProjectCircuitKind::Module,
        vec![component(
            "to-b",
            "project.module_instance",
            serde_json::json!({"moduleId": "b", "label": "B"}),
        )],
        vec![],
    );
    let cyclic_b = circuit(
        "b",
        ProjectCircuitKind::Module,
        vec![component(
            "to-a",
            "project.module_instance",
            serde_json::json!({"moduleId": "a", "label": "A"}),
        )],
        vec![],
    );
    let duplicate_main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component("same", "sink.probe", serde_json::json!({})),
            component("same", "sink.probe", serde_json::json!({})),
        ],
        vec![
            wire("same-wire", "same", "in", "same", "in"),
            wire("same-wire", "same", "in", "same", "in"),
        ],
    );
    let mut forward = project(vec![duplicate_main, cyclic_a, cyclic_b]);
    let mut reverse = forward.clone();
    reverse.circuits.reverse();
    for circuit in &mut reverse.circuits {
        circuit.components.reverse();
        circuit.wires.reverse();
    }
    let forward_errors = lower_project_v3(forward.clone()).unwrap_err();
    let reverse_errors = lower_project_v3(reverse).unwrap_err();
    assert_eq!(forward_errors, reverse_errors);
    let codes = forward_errors
        .iter()
        .map(|error| error.code.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert!(codes.contains("DUPLICATE_COMPONENT_ID"));
    assert!(codes.contains("DUPLICATE_WIRE_ID"));

    forward.circuits[0]
        .components
        .dedup_by(|left, right| left.id == right.id);
    forward.circuits[0]
        .wires
        .dedup_by(|left, right| left.id == right.id);
    let cycle_errors = lower_project_v3(forward).unwrap_err();
    assert!(
        cycle_errors
            .iter()
            .any(|error| error.code == "MODULE_DEPENDENCY_CYCLE")
    );
}

#[test]
fn scalar_component_and_connection_budgets_fail_before_cartesian_allocation() {
    let too_many_components = (0..371)
        .map(|index| {
            component(
                &format!("word-{index:03}"),
                "source.constant",
                serde_json::json!({"width": 27, "value": "0".repeat(27)}),
            )
        })
        .collect();
    let errors = diagnostics(project(vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        too_many_components,
        vec![],
    )]));
    let component_limit = errors
        .iter()
        .find(|error| error.code == "HIERARCHY_EXPANSION_LIMIT")
        .unwrap();
    assert_eq!(component_limit.component_refs[0].circuit_id, "main");
    assert!(
        component_limit.component_refs[0]
            .component_id
            .starts_with("word-")
    );

    let mut components = vec![component(
        "junction",
        "wiring.junction",
        serde_json::json!({}),
    )];
    let mut wires = Vec::new();
    for index in 0..224 {
        components.push(component(
            &format!("driver-{index:03}"),
            "source.constant",
            serde_json::json!({"value": "0"}),
        ));
        wires.push(wire(
            &format!("driver-wire-{index:03}"),
            &format!("driver-{index:03}"),
            "out",
            "junction",
            "net",
        ));
        components.push(component(
            &format!("consumer-{index:03}"),
            "sink.probe",
            serde_json::json!({}),
        ));
        wires.push(wire(
            &format!("consumer-wire-{index:03}"),
            "junction",
            "net",
            &format!("consumer-{index:03}"),
            "in",
        ));
    }
    let errors = diagnostics(project(vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        components,
        wires,
    )]));
    let connection_limit = errors
        .iter()
        .find(|error| error.code == "HIERARCHY_EXPANSION_LIMIT")
        .unwrap();
    assert!(
        !connection_limit.component_refs.is_empty() || !connection_limit.connection_refs.is_empty()
    );
}

#[test]
fn projection_budget_is_checked_symbolically_for_compile_time_helpers() {
    let splitters = (0..1852)
        .map(|index| {
            component(
                &format!("splitter-{index:04}"),
                "wiring.splitter",
                serde_json::json!({
                    "width": 27,
                    "branchCount": 1,
                    "mapping": vec![0; 27]
                }),
            )
        })
        .collect();
    let errors = diagnostics(project(vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        splitters,
        vec![],
    )]));
    let limit = errors
        .iter()
        .find(|error| error.code == "HIERARCHY_EXPANSION_LIMIT")
        .unwrap();
    assert!(limit.message.contains("projection endpoint"));
    assert_eq!(limit.component_refs.len(), 1);
    assert!(
        limit.component_refs[0]
            .component_id
            .starts_with("splitter-")
    );
}

#[test]
fn hierarchy_multiplied_reassembly_budget_fails_at_an_original_instance() {
    let helper_module = circuit(
        "helper-module",
        ProjectCircuitKind::Module,
        vec![component(
            "splitter",
            "wiring.splitter",
            serde_json::json!({
                "width": 27,
                "branchCount": 1,
                "mapping": vec![0; 27]
            }),
        )],
        vec![],
    );
    let instances = (0..1852)
        .map(|index| {
            component(
                &format!("helper-{index:04}"),
                "project.module_instance",
                serde_json::json!({"moduleId": "helper-module", "label": "Helper"}),
            )
        })
        .collect();
    let main = circuit("main", ProjectCircuitKind::Main, instances, vec![]);

    let errors = compile_project_v3(project(vec![main, helper_module]), "main").unwrap_err();
    let limit = errors
        .iter()
        .find(|error| error.code == "HIERARCHY_EXPANSION_LIMIT")
        .unwrap();
    assert!(limit.message.contains("reassembly endpoint"));
    assert_eq!(limit.component_refs.len(), 1);
    assert_eq!(limit.component_refs[0].circuit_id, "main");
    assert!(limit.component_refs[0].component_id.starts_with("helper-"));
}

#[test]
fn wire_bit_analysis_budget_fails_before_allocating_wire_bit_metadata() {
    let components = vec![
        component("left", "wiring.junction", serde_json::json!({"width": 27})),
        component("right", "wiring.junction", serde_json::json!({"width": 27})),
    ];
    let wires = (0..3704)
        .map(|index| wire(&format!("wide-{index:04}"), "left", "net", "right", "net"))
        .collect();

    let errors = diagnostics(project(vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        components,
        wires,
    )]));
    let limit = errors
        .iter()
        .find(|error| error.code == "HIERARCHY_EXPANSION_LIMIT")
        .unwrap();
    assert!(limit.message.contains("wire-bit analysis edge"));
    assert!(!limit.connection_refs.is_empty());
}

#[test]
fn hierarchy_multiplied_provenance_amplification_is_bounded() {
    let mut components = vec![component(
        "junction",
        "wiring.junction",
        serde_json::json!({}),
    )];
    let mut wires = Vec::new();
    for index in 0..50 {
        components.push(component(
            &format!("driver-{index:02}"),
            "source.constant",
            serde_json::json!({"value": "0"}),
        ));
        wires.push(wire(
            &format!("driver-wire-{index:02}"),
            &format!("driver-{index:02}"),
            "out",
            "junction",
            "net",
        ));
        components.push(component(
            &format!("consumer-{index:02}"),
            "sink.probe",
            serde_json::json!({}),
        ));
        wires.push(wire(
            &format!("consumer-wire-{index:02}"),
            "junction",
            "net",
            &format!("consumer-{index:02}"),
            "in",
        ));
    }
    let fanout = circuit("fanout", ProjectCircuitKind::Module, components, wires);
    let instances = (0..9)
        .map(|index| {
            component(
                &format!("fanout-{index}"),
                "project.module_instance",
                serde_json::json!({"moduleId": "fanout", "label": "Fanout"}),
            )
        })
        .collect();
    let main = circuit("main", ProjectCircuitKind::Main, instances, vec![]);

    let errors = compile_project_v3(project(vec![main, fanout]), "main").unwrap_err();
    let limit = errors
        .iter()
        .find(|error| error.code == "HIERARCHY_EXPANSION_LIMIT")
        .unwrap();
    assert!(limit.message.contains("provenance reference"));
    assert_eq!(limit.component_refs[0].circuit_id, "main");
    assert!(limit.component_refs[0].component_id.starts_with("fanout-"));
}

#[test]
fn cross_boundary_provenance_amplification_is_bounded_before_composition() {
    let child = circuit(
        "child",
        ProjectCircuitKind::Module,
        vec![
            component(
                "source",
                "source.constant",
                serde_json::json!({"value": "0"}),
            ),
            component(
                "output",
                "project.module_output",
                serde_json::json!({"portId": "out", "label": "Out"}),
            ),
        ],
        (0..41)
            .map(|index| {
                wire(
                    &format!("segment-{index:02}"),
                    "source",
                    "out",
                    "output",
                    "in",
                )
            })
            .collect(),
    );
    let mut components = vec![component(
        "child",
        "project.module_instance",
        serde_json::json!({"moduleId": "child", "label": "Child"}),
    )];
    let mut wires = Vec::new();
    for index in 0..1400 {
        components.push(component(
            &format!("probe-{index:04}"),
            "sink.probe",
            serde_json::json!({}),
        ));
        wires.push(wire(
            &format!("fanout-{index:04}"),
            "child",
            "out",
            &format!("probe-{index:04}"),
            "in",
        ));
    }
    let main = circuit("main", ProjectCircuitKind::Main, components, wires);

    let errors = match compile_project_v3(project(vec![main, child]), "main") {
        Ok(_) => panic!("cross-boundary provenance amplification must be rejected"),
        Err(errors) => errors,
    };
    let limit = errors
        .iter()
        .find(|error| error.code == "HIERARCHY_EXPANSION_LIMIT")
        .unwrap();
    assert!(limit.message.contains("provenance reference"));
    assert!(!limit.component_refs.is_empty() || !limit.connection_refs.is_empty());
}
