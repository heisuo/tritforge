use sim_core::hierarchy::{FlatPortRef, compile_project};
use sim_core::project::{
    ProjectCircuit, ProjectCircuitKind, ProjectComponent, ProjectConnection, ProjectDiagnostic,
    ProjectDocument, QualifiedComponentRef, QualifiedPortRef,
};
use sim_core::project_validation::{ValidatedProject, validate_project};
use sim_core::simulator::Simulator;
use sim_core::trit::Trit;

fn component(id: &str, type_id: &str, properties: serde_json::Value) -> ProjectComponent {
    ProjectComponent::new(id, type_id, properties).unwrap()
}

fn module_input(id: &str, port_id: &str) -> ProjectComponent {
    component(
        id,
        "project.module_input",
        serde_json::json!({"portId": port_id, "label": port_id, "previewValue": "0"}),
    )
}

fn module_output(id: &str, port_id: &str) -> ProjectComponent {
    component(
        id,
        "project.module_output",
        serde_json::json!({"portId": port_id, "label": port_id}),
    )
}

fn module_instance(id: &str, module_id: &str) -> ProjectComponent {
    component(
        id,
        "project.module_instance",
        serde_json::json!({"moduleId": module_id, "label": id}),
    )
}

fn connection(
    id: impl Into<String>,
    source_component_id: impl Into<String>,
    source_port_id: impl Into<String>,
    target_component_id: impl Into<String>,
    target_port_id: impl Into<String>,
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
    id: impl Into<String>,
    kind: ProjectCircuitKind,
    components: Vec<ProjectComponent>,
    connections: Vec<ProjectConnection>,
) -> ProjectCircuit {
    let id = id.into();
    ProjectCircuit {
        name: id.clone(),
        id,
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

fn validated(circuits: Vec<ProjectCircuit>) -> ValidatedProject {
    validate_project(project(circuits)).expect("fixture project is valid")
}

fn identity_module(id: &str) -> ProjectCircuit {
    circuit(
        id,
        ProjectCircuitKind::Module,
        vec![module_input("input", "a"), module_output("output", "y")],
        vec![connection("pass", "input", "out", "output", "in")],
    )
}

fn bit_cell_module() -> ProjectCircuit {
    circuit(
        "bit-cell",
        ProjectCircuitKind::Module,
        vec![
            module_input("d-input", "d"),
            module_input("en-input", "en"),
            module_input("rst-input", "rst"),
            module_input("clk-input", "clk"),
            component("dff", "sequential.dff", serde_json::json!({})),
            module_output("q-output", "q"),
        ],
        vec![
            connection("d", "d-input", "out", "dff", "d"),
            connection("en", "en-input", "out", "dff", "en"),
            connection("rst", "rst-input", "out", "dff", "rst"),
            connection("clk", "clk-input", "out", "dff", "clk"),
            connection("q", "dff", "q", "q-output", "in"),
        ],
    )
}

fn assert_limit(result: Result<impl Sized, Vec<ProjectDiagnostic>>) -> ProjectDiagnostic {
    let diagnostics = match result {
        Ok(_) => panic!("hierarchy must exceed a fixed budget"),
        Err(diagnostics) => diagnostics,
    };
    let diagnostic = diagnostics
        .into_iter()
        .find(|diagnostic| diagnostic.code == "HIERARCHY_EXPANSION_LIMIT")
        .unwrap_or_else(|| panic!("unexpected diagnostics"));
    assert!(
        diagnostic
            .component_refs
            .iter()
            .all(|reference| !reference.component_id.is_empty()),
        "budget diagnostics must never contain fake empty component IDs: {diagnostic:?}"
    );
    diagnostic
}

#[test]
fn rejects_a_missing_active_circuit_without_a_fake_component_location() {
    let main = circuit("main", ProjectCircuitKind::Main, vec![], vec![]);
    let diagnostics = compile_project(&validated(vec![main]), "missing").unwrap_err();

    assert_eq!(diagnostics[0].code, "INVALID_ACTIVE_CIRCUIT");
    assert!(diagnostics[0].primary_location.is_none());
    assert!(diagnostics[0].component_refs.is_empty());
}

#[test]
fn compiles_two_levels_by_rewiring_boundaries_without_buffers() {
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "source",
                "source.trit_input",
                serde_json::json!({"value": "1"}),
            ),
            module_instance("identity-1", "identity"),
            component("probe", "sink.probe", serde_json::json!({})),
        ],
        vec![
            connection("drive", "source", "out", "identity-1", "a"),
            connection("read", "identity-1", "y", "probe", "in"),
        ],
    );

    let compiled = compile_project(&validated(vec![main, identity_module("identity")]), "main")
        .expect("valid hierarchy");
    assert_eq!(compiled.circuit.components.len(), 2);
    assert_eq!(compiled.circuit.connections.len(), 1);
    assert!(
        compiled
            .circuit
            .components
            .iter()
            .all(|component| !component.type_id.starts_with("project."))
    );

    let simulator = Simulator::load(compiled.circuit).unwrap();
    assert_eq!(
        simulator.snapshot().input_value("probe", "in"),
        Some(Trit::Pos)
    );
}

#[test]
fn compiles_shared_dff_modules_to_distinct_flat_state_and_output_projections() {
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            module_instance("left", "bit-cell"),
            module_instance("right", "bit-cell"),
        ],
        vec![],
    );

    let compiled = compile_project(&validated(vec![main, bit_cell_module()]), "main").unwrap();
    let dff_count = compiled
        .circuit
        .components
        .iter()
        .filter(|component| component.type_id == "sequential.dff")
        .count();
    assert_eq!(dff_count, 2);

    let flat_id_for = |reference: &QualifiedComponentRef| {
        compiled
            .circuit
            .components
            .iter()
            .filter(|component| component.type_id == "sequential.dff")
            .find_map(|component| {
                (compiled.provenance.components.get(&component.id) == Some(reference))
                    .then(|| component.id.clone())
            })
            .expect("each shared DFF source reference has one flat component")
    };
    let left_ref = QualifiedComponentRef::new("bit-cell", ["left"], "dff");
    let right_ref = QualifiedComponentRef::new("bit-cell", ["right"], "dff");
    let left_flat_id = flat_id_for(&left_ref);
    let right_flat_id = flat_id_for(&right_ref);

    assert_ne!(left_flat_id, right_flat_id);
    for (instance_id, flat_id) in [("left", left_flat_id), ("right", right_flat_id)] {
        assert_eq!(
            compiled.projection.ports
                [&QualifiedPortRef::new("main", [] as [&str; 0], instance_id, "q")]
                .drivers,
            [FlatPortRef {
                component_id: flat_id,
                port_id: "q".into(),
            }]
        );
    }
}

#[test]
fn compiles_three_levels_and_keeps_an_unconnected_input_high_impedance() {
    let wrapper = circuit(
        "wrapper",
        ProjectCircuitKind::Module,
        vec![
            module_input("input", "a"),
            module_instance("identity-1", "identity"),
            module_output("output", "y"),
        ],
        vec![
            connection("inside-drive", "input", "out", "identity-1", "a"),
            connection("inside-read", "identity-1", "y", "output", "in"),
        ],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            module_instance("wrapper-1", "wrapper"),
            component("probe", "sink.probe", serde_json::json!({})),
        ],
        vec![connection("read", "wrapper-1", "y", "probe", "in")],
    );

    let compiled = compile_project(
        &validated(vec![main, wrapper, identity_module("identity")]),
        "main",
    )
    .expect("valid hierarchy");
    let simulator = Simulator::load(compiled.circuit).unwrap();
    assert_eq!(
        simulator.snapshot().input_value("probe", "in"),
        Some(Trit::HighZ)
    );
}

#[test]
fn flat_ids_are_deterministic_and_escape_path_separators() {
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component("a/b", "source.constant", serde_json::json!({"value": "0"})),
            component("a~1b", "source.constant", serde_json::json!({"value": "0"})),
            component("name::part", "sink.probe", serde_json::json!({})),
        ],
        vec![],
    );
    let validated = validated(vec![main]);

    let first = compile_project(&validated, "main").unwrap();
    let second = compile_project(&validated, "main").unwrap();
    assert_eq!(first, second);
    let ids: Vec<_> = first
        .circuit
        .components
        .iter()
        .map(|component| component.id.as_str())
        .collect();
    assert!(ids.iter().any(|id| id.contains("~1")));
    assert!(ids.iter().any(|id| id.contains("~0")));
    assert!(ids.iter().any(|id| id.contains("::")));
    assert_eq!(
        ids.len(),
        ids.iter().collect::<std::collections::BTreeSet<_>>().len()
    );
}

#[test]
fn rewiring_forms_the_driver_consumer_cartesian_product() {
    let fanout = circuit(
        "fanout",
        ProjectCircuitKind::Module,
        vec![
            module_input("input", "a"),
            component("probe-1", "sink.probe", serde_json::json!({})),
            component("probe-2", "sink.probe", serde_json::json!({})),
        ],
        vec![
            connection("fanout-1", "input", "out", "probe-1", "in"),
            connection("fanout-2", "input", "out", "probe-2", "in"),
        ],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "source-1",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            component(
                "source-2",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            module_instance("fanout-1", "fanout"),
        ],
        vec![
            connection("driver-1", "source-1", "out", "fanout-1", "a"),
            connection("driver-2", "source-2", "out", "fanout-1", "a"),
        ],
    );

    let compiled = compile_project(&validated(vec![main, fanout]), "main").unwrap();
    assert_eq!(compiled.circuit.components.len(), 4);
    assert_eq!(compiled.circuit.connections.len(), 4);
}

#[test]
fn compiles_a_large_transparent_alias_cycle_with_bounded_provenance_work() {
    const INSTANCE_COUNT: usize = 2_000;
    let mut components = vec![
        component(
            "source",
            "source.constant",
            serde_json::json!({"value": "1"}),
        ),
        component("probe", "sink.probe", serde_json::json!({})),
    ];
    components.extend(
        (0..INSTANCE_COUNT).map(|index| module_instance(&format!("identity-{index}"), "identity")),
    );
    let mut connections = vec![
        connection("drive", "source", "out", "identity-0", "a"),
        connection(
            "tap",
            format!("identity-{}", INSTANCE_COUNT / 2),
            "y",
            "probe",
            "in",
        ),
    ];
    connections.extend((0..INSTANCE_COUNT).map(|index| {
        connection(
            format!("cycle-{index}"),
            format!("identity-{index}"),
            "y",
            format!("identity-{}", (index + 1) % INSTANCE_COUNT),
            "a",
        )
    }));
    let main = circuit("main", ProjectCircuitKind::Main, components, connections);

    let compiled = compile_project(&validated(vec![main, identity_module("identity")]), "main")
        .expect("bounded alias cycle should compile");
    assert_eq!(compiled.circuit.connections.len(), 1);
    assert_eq!(
        compiled.provenance.connections["flat-wire-00000"].len(),
        (INSTANCE_COUNT * 2) + 2
    );
}

#[test]
fn compiles_a_long_transparent_chain_without_quadratic_provenance_storage() {
    const INSTANCE_COUNT: usize = 2_000;
    let mut components = vec![
        component(
            "source",
            "source.constant",
            serde_json::json!({"value": "1"}),
        ),
        component("probe", "sink.probe", serde_json::json!({})),
    ];
    components.extend(
        (0..INSTANCE_COUNT).map(|index| module_instance(&format!("identity-{index}"), "identity")),
    );
    let mut connections = vec![connection("drive", "source", "out", "identity-0", "a")];
    connections.extend((0..INSTANCE_COUNT - 1).map(|index| {
        connection(
            format!("link-{index}"),
            format!("identity-{index}"),
            "y",
            format!("identity-{}", index + 1),
            "a",
        )
    }));
    connections.push(connection(
        "read",
        format!("identity-{}", INSTANCE_COUNT - 1),
        "y",
        "probe",
        "in",
    ));
    let main = circuit("main", ProjectCircuitKind::Main, components, connections);

    let compiled = compile_project(&validated(vec![main, identity_module("identity")]), "main")
        .expect("long transparent chain should compile");
    assert_eq!(compiled.circuit.connections.len(), 1);
    assert_eq!(
        compiled.provenance.connections["flat-wire-00000"].len(),
        (INSTANCE_COUNT * 2) + 1
    );
}

#[test]
fn rejects_depth_thirty_three_before_expansion() {
    let mut circuits = Vec::new();
    circuits.push(circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![module_instance("next", "module-00")],
        vec![],
    ));
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
            vec![],
        ));
    }
    let project = validated(circuits);
    let diagnostic = assert_limit(compile_project(&project, "main"));
    assert!(diagnostic.message.contains("depth 33"));
    assert!(!diagnostic.component_refs.is_empty());
}

#[test]
fn rejects_a_five_thousand_level_chain_without_recursive_counting() {
    const MODULE_COUNT: usize = 5_000;
    let mut circuits = Vec::with_capacity(MODULE_COUNT + 1);
    circuits.push(circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![module_instance("next", "module-0000")],
        vec![],
    ));
    for index in 0..MODULE_COUNT {
        let components = if index + 1 < MODULE_COUNT {
            vec![module_instance("next", &format!("module-{:04}", index + 1))]
        } else {
            vec![]
        };
        circuits.push(circuit(
            format!("module-{index:04}"),
            ProjectCircuitKind::Module,
            components,
            vec![],
        ));
    }

    let project = validated(circuits);
    assert_limit(compile_project(&project, "main"));
}

#[test]
fn rejects_exponential_empty_instances_before_symbolic_expansion() {
    let leaf = circuit("leaf", ProjectCircuitKind::Module, vec![], vec![]);
    let level_one = circuit(
        "level-one",
        ProjectCircuitKind::Module,
        (0..101)
            .map(|index| module_instance(&format!("leaf-{index}"), "leaf"))
            .collect(),
        vec![],
    );
    let level_two = circuit(
        "level-two",
        ProjectCircuitKind::Module,
        (0..101)
            .map(|index| module_instance(&format!("one-{index}"), "level-one"))
            .collect(),
        vec![],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        (0..101)
            .map(|index| module_instance(&format!("two-{index}"), "level-two"))
            .collect(),
        vec![],
    );

    let diagnostic = assert_limit(compile_project(
        &validated(vec![main, level_two, level_one, leaf]),
        "main",
    ));
    assert!(diagnostic.message.contains("instance count"));
    assert!(diagnostic.message.contains("1040603"));
}

#[test]
fn rejects_ten_thousand_and_one_flat_components() {
    let components = (0..10_001)
        .map(|index| {
            component(
                &format!("constant-{index}"),
                "source.constant",
                serde_json::json!({"value": "0"}),
            )
        })
        .collect();
    let main = circuit("main", ProjectCircuitKind::Main, components, vec![]);
    let project = validated(vec![main]);
    let diagnostic = assert_limit(compile_project(&project, "main"));
    assert!(diagnostic.message.contains("10001"));
}

#[test]
fn rejects_fifty_thousand_and_one_flat_connections() {
    let mut components = Vec::new();
    for source in 0..251 {
        components.push(component(
            &format!("source-{source}"),
            "source.constant",
            serde_json::json!({"value": "0"}),
        ));
    }
    for target in 0..200 {
        components.push(component(
            &format!("target-{target}"),
            "sink.probe",
            serde_json::json!({}),
        ));
    }
    let mut connections = Vec::new();
    'outer: for source in 0..251 {
        for target in 0..200 {
            connections.push(connection(
                format!("wire-{source}-{target}"),
                format!("source-{source}"),
                "out",
                format!("target-{target}"),
                "in",
            ));
            if connections.len() == 50_001 {
                break 'outer;
            }
        }
    }
    let project = validated(vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        components,
        connections,
    )]);
    let diagnostic = assert_limit(compile_project(&project, "main"));
    assert!(diagnostic.message.contains("at least"));
    assert!(diagnostic.message.contains("exceeding 50000"));
}

#[test]
fn rejects_a_boundary_cartesian_product_during_analysis() {
    let mut fanout_components = vec![module_input("input", "a")];
    let mut fanout_connections = Vec::new();
    for target in 0..200 {
        fanout_components.push(component(
            &format!("target-{target}"),
            "sink.probe",
            serde_json::json!({}),
        ));
        fanout_connections.push(connection(
            format!("fanout-{target}"),
            "input",
            "out",
            format!("target-{target}"),
            "in",
        ));
    }
    let fanout = circuit(
        "fanout",
        ProjectCircuitKind::Module,
        fanout_components,
        fanout_connections,
    );

    let mut main_components = vec![module_instance("fanout-1", "fanout")];
    let mut main_connections = Vec::new();
    for source in 0..251 {
        main_components.push(component(
            &format!("source-{source}"),
            "source.constant",
            serde_json::json!({"value": "0"}),
        ));
        main_connections.push(connection(
            format!("driver-{source}"),
            format!("source-{source}"),
            "out",
            "fanout-1",
            "a",
        ));
    }
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        main_components,
        main_connections,
    );

    let diagnostic = assert_limit(compile_project(&validated(vec![main, fanout]), "main"));
    assert!(diagnostic.message.contains("at least"));
    assert!(diagnostic.message.contains("exceeding 50000"));
    assert_eq!(diagnostic.component_refs[0].component_id, "fanout-1");
}

#[test]
fn rejects_one_hundred_thousand_and_one_projection_endpoints() {
    let mut components = vec![component(
        "source",
        "source.constant",
        serde_json::json!({"value": "0"}),
    )];
    let mut connections = Vec::new();
    for index in 0..100_001 {
        let boundary_id = format!("output-{index}");
        let port_id = format!("port-{index}");
        components.push(module_output(&boundary_id, &port_id));
        connections.push(connection(
            format!("wire-{index}"),
            "source",
            "out",
            boundary_id,
            "in",
        ));
    }
    let many_outputs = circuit(
        "many-outputs",
        ProjectCircuitKind::Module,
        components,
        connections,
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![module_instance("many-1", "many-outputs")],
        vec![],
    );
    let project = validated(vec![main, many_outputs]);
    let diagnostic = assert_limit(compile_project(&project, "main"));
    assert!(diagnostic.message.contains("symbolic analysis node count"));
    assert!(diagnostic.message.contains("200003"));
}

#[test]
fn rejects_checked_count_overflow() {
    let mut circuits = vec![circuit(
        "leaf",
        ProjectCircuitKind::Module,
        vec![component(
            "constant",
            "source.constant",
            serde_json::json!({"value": "0"}),
        )],
        vec![],
    )];
    let mut previous = "leaf".to_owned();
    for level in 0..12 {
        let id = format!("level-{level}");
        let instances = (0..100)
            .map(|index| module_instance(&format!("instance-{index}"), &previous))
            .collect();
        circuits.push(circuit(&id, ProjectCircuitKind::Module, instances, vec![]));
        previous = id;
    }
    circuits.push(circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![module_instance("root", &previous)],
        vec![],
    ));
    let project = validated(circuits);
    assert_limit(compile_project(&project, "main"));
}
