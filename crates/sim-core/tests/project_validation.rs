use sim_core::catalog::PortDirection;
use sim_core::project::{
    ProjectCircuit, ProjectCircuitKind, ProjectComponent, ProjectConnection, ProjectDiagnostic,
    ProjectDocument,
};
use sim_core::project_validation::validate_project;

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

fn main_circuit(components: Vec<ProjectComponent>) -> ProjectCircuit {
    circuit("main", ProjectCircuitKind::Main, components, vec![])
}

fn module_circuit(id: &str, components: Vec<ProjectComponent>) -> ProjectCircuit {
    circuit(id, ProjectCircuitKind::Module, components, vec![])
}

fn project(circuits: Vec<ProjectCircuit>) -> ProjectDocument {
    ProjectDocument {
        format: "logsim-ternary".into(),
        version: 2,
        root_circuit_id: "main".into(),
        circuits,
    }
}

fn assert_code(result: Result<impl Sized, Vec<ProjectDiagnostic>>, code: &str) {
    let diagnostics = match result {
        Ok(_) => panic!("project must be rejected"),
        Err(diagnostics) => diagnostics,
    };
    assert!(
        diagnostics.iter().any(|diagnostic| diagnostic.code == code),
        "expected {code}, got {:?}",
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>()
    );
}

fn rejected_codes(result: Result<impl Sized, Vec<ProjectDiagnostic>>) -> Vec<String> {
    match result {
        Ok(_) => panic!("project must be rejected"),
        Err(diagnostics) => diagnostics
            .into_iter()
            .map(|diagnostic| diagnostic.code)
            .collect(),
    }
}

#[test]
fn rejects_an_invalid_root_circuit() {
    let mut invalid = project(vec![main_circuit(vec![])]);
    invalid.root_circuit_id = "missing".into();

    assert_code(validate_project(invalid), "INVALID_ROOT_CIRCUIT");
}

#[test]
fn rejects_wrong_project_format_and_version() {
    let mut invalid_format = project(vec![main_circuit(vec![])]);
    invalid_format.format = "another-format".into();
    assert_code(validate_project(invalid_format), "INVALID_PROJECT_FORMAT");

    let mut invalid_version = project(vec![main_circuit(vec![])]);
    invalid_version.version = 3;
    assert_code(
        validate_project(invalid_version),
        "UNSUPPORTED_PROJECT_VERSION",
    );
}

#[test]
fn rejects_empty_circuit_ids_and_names() {
    let mut empty_id = main_circuit(vec![]);
    empty_id.id.clear();
    let mut invalid_id_project = project(vec![empty_id]);
    invalid_id_project.root_circuit_id.clear();
    assert_code(validate_project(invalid_id_project), "INVALID_CIRCUIT_ID");

    let mut empty_name = main_circuit(vec![]);
    empty_name.name.clear();
    assert_code(
        validate_project(project(vec![empty_name])),
        "INVALID_CIRCUIT_NAME",
    );
}

#[test]
fn rejects_duplicate_circuit_ids() {
    assert_code(
        validate_project(project(vec![
            main_circuit(vec![]),
            module_circuit("main", vec![]),
        ])),
        "DUPLICATE_CIRCUIT_ID",
    );
}

#[test]
fn rejects_module_boundaries_in_main() {
    assert_code(
        validate_project(project(vec![main_circuit(vec![module_input("in", "a")])])),
        "INVALID_MODULE_BOUNDARY",
    );
}

#[test]
fn rejects_duplicate_module_port_ids_across_directions() {
    assert_code(
        validate_project(project(vec![
            main_circuit(vec![]),
            module_circuit(
                "adder",
                vec![
                    module_input("input", "value"),
                    module_output("output", "value"),
                ],
            ),
        ])),
        "DUPLICATE_MODULE_PORT_ID",
    );
}

#[test]
fn duplicate_module_ports_do_not_cascade_or_depend_on_boundary_order() {
    let build = |reverse: bool| {
        let mut boundaries = vec![module_input("input", "p"), module_output("output", "p")];
        if reverse {
            boundaries.reverse();
        }
        let mut main = main_circuit(vec![
            component("source", "source.trit_input", serde_json::json!({})),
            module_instance("ambiguous-1", "ambiguous"),
            component("probe", "sink.probe", serde_json::json!({})),
        ]);
        main.connections = vec![
            connection("drive", "source", "out", "ambiguous-1", "p"),
            connection("read", "ambiguous-1", "p", "probe", "in"),
        ];
        project(vec![main, module_circuit("ambiguous", boundaries)])
    };

    let forward = validate_project(build(false)).unwrap_err();
    let reverse = validate_project(build(true)).unwrap_err();
    assert_eq!(forward, reverse);
    assert_eq!(
        forward
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>(),
        vec!["DUPLICATE_MODULE_PORT_ID"]
    );
}

#[test]
fn rejects_empty_module_port_ids() {
    assert_code(
        validate_project(project(vec![
            main_circuit(vec![]),
            module_circuit("empty-port", vec![module_input("input", "")]),
        ])),
        "INVALID_PROPERTY",
    );
}

#[test]
fn rejects_unknown_module_references() {
    assert_code(
        validate_project(project(vec![main_circuit(vec![module_instance(
            "missing-1",
            "missing",
        )])])),
        "UNKNOWN_MODULE",
    );
}

#[test]
fn rejects_module_instances_that_reference_main() {
    assert_code(
        validate_project(project(vec![main_circuit(vec![module_instance(
            "main-1", "main",
        )])])),
        "MODULE_REFERENCE_NOT_MODULE",
    );
}

#[test]
fn rejects_dynamic_ports_used_in_the_wrong_direction() {
    let mut main = main_circuit(vec![
        module_instance("adder-1", "adder"),
        component("probe", "sink.probe", serde_json::json!({})),
    ]);
    main.connections
        .push(connection("wrong-way", "adder-1", "a", "probe", "in"));

    assert_code(
        validate_project(project(vec![
            main,
            module_circuit("adder", vec![module_input("input-a", "a")]),
        ])),
        "INVALID_MODULE_PORT_DIRECTION",
    );
}

#[test]
fn rejects_indirect_module_dependency_cycles_even_when_unreachable() {
    assert_code(
        validate_project(project(vec![
            main_circuit(vec![]),
            module_circuit("module-a", vec![module_instance("b-1", "module-b")]),
            module_circuit("module-b", vec![module_instance("a-1", "module-a")]),
        ])),
        "MODULE_DEPENDENCY_CYCLE",
    );
}

#[test]
fn reports_disjoint_dependency_cycles_separately_with_instance_locations() {
    let invalid = project(vec![
        main_circuit(vec![]),
        module_circuit("a", vec![module_instance("b-in-a", "b")]),
        module_circuit("b", vec![module_instance("a-in-b", "a")]),
        module_circuit("c", vec![module_instance("d-in-c", "d")]),
        module_circuit("d", vec![module_instance("c-in-d", "c")]),
    ]);

    let diagnostics = validate_project(invalid).unwrap_err();
    let cycles: Vec<_> = diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "MODULE_DEPENDENCY_CYCLE")
        .collect();

    assert_eq!(cycles.len(), 2);
    assert!(cycles.iter().all(|cycle| cycle.component_refs.len() == 2));
    assert_ne!(cycles[0].component_refs, cycles[1].component_refs);
}

#[test]
fn cycle_diagnostics_ignore_component_array_order() {
    let build = |reverse: bool| {
        let mut instances = vec![
            module_instance("z-in-a", "b"),
            module_instance("a-in-a", "b"),
        ];
        if reverse {
            instances.reverse();
        }
        project(vec![
            main_circuit(vec![]),
            module_circuit("a", instances),
            module_circuit("b", vec![module_instance("a-in-b", "a")]),
        ])
    };
    let cycle = |document| {
        validate_project(document)
            .unwrap_err()
            .into_iter()
            .find(|diagnostic| diagnostic.code == "MODULE_DEPENDENCY_CYCLE")
            .unwrap()
    };

    assert_eq!(cycle(build(false)), cycle(build(true)));
}

#[test]
fn validates_unknown_gates_in_unreachable_modules() {
    assert_code(
        validate_project(project(vec![
            main_circuit(vec![]),
            module_circuit(
                "unused",
                vec![component("bad", "gate.not_real", serde_json::json!({}))],
            ),
        ])),
        "UNKNOWN_COMPONENT_TYPE",
    );
}

#[test]
fn validates_builtin_reserved_properties_in_unreachable_modules() {
    assert_code(
        validate_project(project(vec![
            main_circuit(vec![]),
            module_circuit(
                "unused",
                vec![component(
                    "bad-label",
                    "sink.probe",
                    serde_json::json!({"label": 42}),
                )],
            ),
        ])),
        "INVALID_PROPERTY",
    );
    assert_code(
        validate_project(project(vec![
            main_circuit(vec![]),
            module_circuit(
                "unused",
                vec![component(
                    "bad-value",
                    "source.constant",
                    serde_json::json!({"value": null}),
                )],
            ),
        ])),
        "INVALID_PROPERTY",
    );

    let valid_extension = component(
        "extension",
        "sink.probe",
        serde_json::json!({"label": " ", "moduleId": 42}),
    );
    assert!(validate_project(project(vec![main_circuit(vec![valid_extension])])).is_ok());
}

#[test]
fn clock_and_dff_require_empty_runtime_properties() {
    let valid = main_circuit(vec![
        component("clock", "source.clock", serde_json::json!({})),
        component("dff", "sequential.dff", serde_json::json!({})),
    ]);
    assert!(validate_project(project(vec![valid])).is_ok());

    for type_id in ["source.clock", "sequential.dff"] {
        assert_code(
            validate_project(project(vec![main_circuit(vec![component(
                "stateful",
                type_id,
                serde_json::json!({"value": "1"}),
            )])])),
            "INVALID_PROPERTY",
        );
    }
}

#[test]
fn rejects_reserved_properties_that_do_not_belong_to_a_special_component() {
    let malformed = component(
        "output",
        "project.module_output",
        serde_json::json!({
            "portId": "y",
            "label": "Y",
            "previewValue": "0"
        }),
    );

    assert_code(
        validate_project(project(vec![
            main_circuit(vec![]),
            module_circuit("malformed", vec![malformed]),
        ])),
        "INVALID_PROPERTY",
    );
}

#[test]
fn malformed_but_identifiable_boundaries_do_not_cascade_to_unknown_ports() {
    let malformed_output = component(
        "output",
        "project.module_output",
        serde_json::json!({"portId": "y"}),
    );
    let mut main = main_circuit(vec![
        module_instance("broken-1", "broken"),
        component("probe", "sink.probe", serde_json::json!({})),
    ]);
    main.connections = vec![connection("read", "broken-1", "y", "probe", "in")];

    let codes = rejected_codes(validate_project(project(vec![
        main,
        module_circuit("broken", vec![malformed_output]),
    ])));
    assert!(codes.contains(&"INVALID_PROPERTY".into()));
    assert!(!codes.contains(&"UNKNOWN_MODULE_PORT".into()));
}

#[test]
fn rejects_duplicate_connection_ids_inside_one_circuit() {
    let mut module = module_circuit(
        "wire",
        vec![module_input("input", "a"), module_output("output", "y")],
    );
    module.connections = vec![
        connection("wire-1", "input", "out", "output", "in"),
        connection("wire-1", "input", "out", "output", "in"),
    ];

    assert_code(
        validate_project(project(vec![main_circuit(vec![]), module])),
        "DUPLICATE_CONNECTION_ID",
    );
}

#[test]
fn invalid_components_do_not_cascade_into_endpoint_errors() {
    let mut duplicate_main = main_circuit(vec![
        component("duplicate", "source.trit_input", serde_json::json!({})),
        component("duplicate", "source.trit_input", serde_json::json!({})),
        component("probe", "sink.probe", serde_json::json!({})),
    ]);
    duplicate_main.connections = vec![connection("wire", "duplicate", "out", "probe", "in")];
    let duplicate_codes = rejected_codes(validate_project(project(vec![duplicate_main])));
    assert!(duplicate_codes.contains(&"DUPLICATE_COMPONENT_ID".into()));
    assert!(!duplicate_codes.contains(&"UNKNOWN_COMPONENT".into()));
    assert!(!duplicate_codes.contains(&"UNKNOWN_PORT".into()));

    let mut unknown_type_main = main_circuit(vec![
        component("bad", "gate.not_real", serde_json::json!({})),
        component("probe", "sink.probe", serde_json::json!({})),
    ]);
    unknown_type_main.connections = vec![connection("wire", "bad", "out", "probe", "in")];
    let unknown_type_codes = rejected_codes(validate_project(project(vec![unknown_type_main])));
    assert!(unknown_type_codes.contains(&"UNKNOWN_COMPONENT_TYPE".into()));
    assert!(!unknown_type_codes.contains(&"UNKNOWN_PORT".into()));

    let mut unknown_module_main = main_circuit(vec![
        module_instance("missing-1", "missing"),
        component("probe", "sink.probe", serde_json::json!({})),
    ]);
    unknown_module_main.connections = vec![connection("wire", "missing-1", "y", "probe", "in")];
    let unknown_module_codes = rejected_codes(validate_project(project(vec![unknown_module_main])));
    assert!(unknown_module_codes.contains(&"UNKNOWN_MODULE".into()));
    assert!(!unknown_module_codes.contains(&"UNKNOWN_MODULE_PORT".into()));
}

#[test]
fn dependency_validation_handles_a_deep_acyclic_chain_iteratively() {
    const MODULE_COUNT: usize = 5_000;
    let mut circuits = Vec::with_capacity(MODULE_COUNT + 1);
    circuits.push(main_circuit(vec![]));
    for index in 0..MODULE_COUNT {
        let id = format!("module-{index:04}");
        let components = if index + 1 < MODULE_COUNT {
            vec![module_instance("next", &format!("module-{:04}", index + 1))]
        } else {
            vec![]
        };
        circuits.push(module_circuit(&id, components));
    }

    assert!(validate_project(project(circuits)).is_ok());
}

#[test]
fn dense_strongly_connected_dependency_graph_reports_one_cycle() {
    const MODULE_COUNT: usize = 24;
    let mut circuits = vec![main_circuit(vec![])];
    for source in 0..MODULE_COUNT {
        let instances = (0..MODULE_COUNT)
            .map(|target| {
                module_instance(
                    &format!("instance-{target:02}"),
                    &format!("module-{target:02}"),
                )
            })
            .collect();
        circuits.push(module_circuit(&format!("module-{source:02}"), instances));
    }

    let diagnostics = validate_project(project(circuits)).unwrap_err();
    assert_eq!(
        diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "MODULE_DEPENDENCY_CYCLE")
            .count(),
        1
    );
}

#[test]
fn exports_boundary_interfaces_and_instance_dependencies_in_component_order() {
    let mut main = main_circuit(vec![module_instance("adder-1", "adder")]);
    main.connections = vec![connection("read-sum", "adder-1", "sum", "probe", "in")];
    main.components
        .push(component("probe", "sink.probe", serde_json::json!({})));
    let adder = module_circuit(
        "adder",
        vec![
            module_output("sum-boundary", "sum"),
            module_input("a-boundary", "a"),
        ],
    );

    let validated = validate_project(project(vec![main, adder])).unwrap();
    let ports = &validated.interfaces["adder"];

    assert_eq!(ports[0].id, "sum");
    assert_eq!(ports[0].direction, PortDirection::Output);
    assert_eq!(ports[0].boundary_component_id, "sum-boundary");
    assert_eq!(ports[1].id, "a");
    assert_eq!(ports[1].direction, PortDirection::Input);
    assert_eq!(validated.dependencies["main"], vec!["adder"]);
    assert!(validated.dependencies["adder"].is_empty());
    assert!(validated.warnings.is_empty());
}

#[test]
fn special_components_own_only_their_fixed_or_dynamic_handles() {
    let mut module = module_circuit(
        "identity",
        vec![module_input("input", "a"), module_output("output", "y")],
    );
    module.connections = vec![connection("inside", "input", "a", "output", "in")];
    assert_code(
        validate_project(project(vec![main_circuit(vec![]), module])),
        "UNKNOWN_MODULE_PORT",
    );

    let mut main = main_circuit(vec![
        module_instance("identity-1", "identity"),
        component("probe", "sink.probe", serde_json::json!({})),
    ]);
    main.connections = vec![connection(
        "outside",
        "identity-1",
        "missing",
        "probe",
        "in",
    )];
    assert_code(
        validate_project(project(vec![
            main,
            module_circuit(
                "identity",
                vec![module_input("input", "a"), module_output("output", "y")],
            ),
        ])),
        "UNKNOWN_MODULE_PORT",
    );
}
