use sim_core::catalog::ComponentProperties;
use sim_core::circuit::{
    CircuitDefinition, ComponentInstance, Connection, PortRef, validate_circuit,
};
use sim_core::diagnostic::{Diagnostic, DiagnosticSeverity};
use sim_core::trit::Trit;

fn component(id: &str, type_id: &str) -> ComponentInstance {
    ComponentInstance {
        id: id.to_owned(),
        type_id: type_id.to_owned(),
        properties: ComponentProperties::default(),
    }
}

fn component_with_value(id: &str, type_id: &str, value: Option<Trit>) -> ComponentInstance {
    ComponentInstance {
        id: id.to_owned(),
        type_id: type_id.to_owned(),
        properties: ComponentProperties { value },
    }
}

fn connection(
    id: &str,
    source_component_id: &str,
    source_port_id: &str,
    target_component_id: &str,
    target_port_id: &str,
) -> Connection {
    Connection {
        id: id.to_owned(),
        source_component_id: source_component_id.to_owned(),
        source_port_id: source_port_id.to_owned(),
        target_component_id: target_component_id.to_owned(),
        target_port_id: target_port_id.to_owned(),
    }
}

fn definition(
    components: Vec<ComponentInstance>,
    connections: Vec<Connection>,
) -> CircuitDefinition {
    CircuitDefinition {
        components,
        connections,
    }
}

fn only_error(definition: CircuitDefinition) -> Diagnostic {
    let diagnostics = validate_circuit(definition).expect_err("circuit must be rejected");
    assert_eq!(diagnostics.len(), 1);
    diagnostics.into_iter().next().unwrap()
}

#[test]
fn accepts_fanout_and_multiple_distinct_drivers() {
    let outcome = validate_circuit(definition(
        vec![
            component("source-b", "source.constant"),
            component("probe-b", "sink.probe"),
            component("source-a", "source.trit_input"),
            component("probe-a", "sink.probe"),
        ],
        vec![
            connection("c3", "source-a", "out", "probe-b", "in"),
            connection("c2", "source-b", "out", "probe-a", "in"),
            connection("c1", "source-a", "out", "probe-a", "in"),
        ],
    ))
    .expect("fanout and multiple drivers are valid");

    assert!(outcome.warnings.is_empty());
    assert_eq!(outcome.circuit.connection_count(), 3);
    assert_eq!(
        outcome.circuit.drivers_for("probe-a", "in"),
        &[
            PortRef::new("source-a", "out"),
            PortRef::new("source-b", "out")
        ]
    );
    assert_eq!(
        outcome.circuit.downstream_for("source-a", "out"),
        &["probe-a".to_owned(), "probe-b".to_owned()]
    );
}

#[test]
fn rejects_duplicate_component_ids() {
    let diagnostic = only_error(definition(
        vec![
            component("same", "source.constant"),
            component("same", "source.trit_input"),
        ],
        vec![],
    ));

    assert_eq!(diagnostic.code, "DUPLICATE_COMPONENT_ID");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
    assert_eq!(diagnostic.component_ids, vec!["same"]);
    assert!(diagnostic.connection_ids.is_empty());
    assert!(diagnostic.port_ids.is_empty());
}

#[test]
fn rejects_unknown_component_types() {
    let diagnostic = only_error(definition(
        vec![component("mystery", "gate.not_registered")],
        vec![],
    ));

    assert_eq!(diagnostic.code, "UNKNOWN_COMPONENT_TYPE");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
    assert_eq!(diagnostic.component_ids, vec!["mystery"]);
    assert!(diagnostic.connection_ids.is_empty());
    assert!(diagnostic.port_ids.is_empty());
}

#[test]
fn rejects_missing_source_and_target_components() {
    let diagnostics = validate_circuit(definition(
        vec![component("probe", "sink.probe")],
        vec![
            connection("missing-target", "probe", "in", "gone-b", "in"),
            connection("missing-source", "gone-a", "out", "probe", "in"),
        ],
    ))
    .expect_err("missing endpoint components must reject the circuit");

    assert_eq!(diagnostics.len(), 2);
    assert_eq!(
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>(),
        vec!["UNKNOWN_COMPONENT", "UNKNOWN_COMPONENT"]
    );
    assert_eq!(diagnostics[0].component_ids, vec!["gone-a"]);
    assert_eq!(diagnostics[0].connection_ids, vec!["missing-source"]);
    assert_eq!(diagnostics[0].port_ids, vec!["out"]);
    assert_eq!(diagnostics[1].component_ids, vec!["gone-b"]);
    assert_eq!(diagnostics[1].connection_ids, vec!["missing-target"]);
    assert_eq!(diagnostics[1].port_ids, vec!["in"]);
    assert!(
        diagnostics
            .iter()
            .all(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
    );
}

#[test]
fn rejects_unknown_source_and_target_ports() {
    let diagnostics = validate_circuit(definition(
        vec![
            component("probe", "sink.probe"),
            component("source", "source.constant"),
        ],
        vec![
            connection("bad-target", "source", "out", "probe", "missing-in"),
            connection("bad-source", "source", "missing-out", "probe", "in"),
        ],
    ))
    .expect_err("unknown endpoint ports must reject the circuit");

    assert_eq!(diagnostics.len(), 2);
    assert_eq!(diagnostics[0].code, "UNKNOWN_PORT");
    assert_eq!(diagnostics[0].component_ids, vec!["source"]);
    assert_eq!(diagnostics[0].connection_ids, vec!["bad-source"]);
    assert_eq!(diagnostics[0].port_ids, vec!["missing-out"]);
    assert_eq!(diagnostics[1].code, "UNKNOWN_PORT");
    assert_eq!(diagnostics[1].component_ids, vec!["probe"]);
    assert_eq!(diagnostics[1].connection_ids, vec!["bad-target"]);
    assert_eq!(diagnostics[1].port_ids, vec!["missing-in"]);
}

#[test]
fn rejects_input_to_input_and_output_to_output_connections() {
    let diagnostics = validate_circuit(definition(
        vec![
            component("buffer", "gate.buf"),
            component("probe", "sink.probe"),
            component("source", "source.constant"),
        ],
        vec![
            connection("input-input", "buffer", "a", "probe", "in"),
            connection("output-output", "source", "out", "buffer", "y"),
        ],
    ))
    .expect_err("source must be output and target must be input");

    assert_eq!(diagnostics.len(), 2);
    assert_eq!(diagnostics[0].code, "INVALID_PORT_DIRECTION");
    assert_eq!(diagnostics[0].component_ids, vec!["buffer", "probe"]);
    assert_eq!(diagnostics[0].connection_ids, vec!["input-input"]);
    assert_eq!(diagnostics[0].port_ids, vec!["a", "in"]);
    assert_eq!(diagnostics[1].code, "INVALID_PORT_DIRECTION");
    assert_eq!(diagnostics[1].component_ids, vec!["source", "buffer"]);
    assert_eq!(diagnostics[1].connection_ids, vec!["output-output"]);
    assert_eq!(diagnostics[1].port_ids, vec!["out", "y"]);
}

#[test]
fn duplicate_endpoint_is_ignored_with_warning() {
    let outcome = validate_circuit(definition(
        vec![
            component("source", "source.constant"),
            component("probe", "sink.probe"),
        ],
        vec![
            connection("z-second", "source", "out", "probe", "in"),
            connection("a-first", "source", "out", "probe", "in"),
        ],
    ))
    .expect("duplicate endpoints only warn");

    assert_eq!(outcome.circuit.connection_count(), 1);
    assert_eq!(outcome.circuit.connections()[0].id, "a-first");
    assert_eq!(outcome.warnings.len(), 1);
    assert_eq!(outcome.warnings[0].code, "DUPLICATE_CONNECTION");
    assert_eq!(outcome.warnings[0].severity, DiagnosticSeverity::Warning);
    assert_eq!(outcome.warnings[0].component_ids, vec!["source", "probe"]);
    assert_eq!(
        outcome.warnings[0].connection_ids,
        vec!["a-first", "z-second"]
    );
    assert_eq!(outcome.warnings[0].port_ids, vec!["out", "in"]);
}

#[test]
fn source_properties_accept_absent_or_known_values() {
    for type_id in ["source.trit_input", "source.constant"] {
        for value in [None, Some(Trit::Neg), Some(Trit::Zero), Some(Trit::Pos)] {
            let outcome = validate_circuit(definition(
                vec![component_with_value("source", type_id, value)],
                vec![],
            ));
            assert!(outcome.is_ok(), "{type_id} rejected {value:?}");
        }
    }
}

#[test]
fn source_properties_reject_meta_values() {
    for type_id in ["source.trit_input", "source.constant"] {
        for value in [Trit::Unknown, Trit::HighZ, Trit::Error] {
            let diagnostic = only_error(definition(
                vec![component_with_value("source", type_id, Some(value))],
                vec![],
            ));
            assert_eq!(diagnostic.code, "INVALID_PROPERTY");
            assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
            assert_eq!(diagnostic.component_ids, vec!["source"]);
            assert!(diagnostic.connection_ids.is_empty());
            assert!(diagnostic.port_ids.is_empty());
        }
    }
}

#[test]
fn gates_and_probe_reject_any_value_property() {
    for type_id in [
        "sink.probe",
        "gate.buf",
        "gate.neg",
        "gate.min",
        "gate.max",
        "gate.is_neg",
        "gate.is_zero",
        "gate.is_pos",
        "gate.mod_sum",
        "gate.consensus",
        "gate.mux2",
        "gate.mux3",
    ] {
        assert!(
            validate_circuit(definition(vec![component("valid", type_id)], vec![])).is_ok(),
            "{type_id} must accept no value"
        );

        let diagnostic = only_error(definition(
            vec![component_with_value("invalid", type_id, Some(Trit::Zero))],
            vec![],
        ));
        assert_eq!(diagnostic.code, "INVALID_PROPERTY");
        assert_eq!(diagnostic.component_ids, vec!["invalid"]);
    }
}

#[test]
fn sequential_components_accept_empty_properties_and_reject_value() {
    for type_id in ["source.clock", "sequential.dff"] {
        assert!(
            validate_circuit(definition(vec![component("valid", type_id)], vec![])).is_ok(),
            "{type_id} must accept no value"
        );

        let diagnostic = only_error(definition(
            vec![component_with_value("invalid", type_id, Some(Trit::Zero))],
            vec![],
        ));
        assert_eq!(diagnostic.code, "INVALID_PROPERTY");
        assert_eq!(diagnostic.component_ids, vec!["invalid"]);
    }
}

#[test]
fn circuit_definition_and_diagnostic_serde_round_trip() {
    let circuit_json = r#"{
        "components": [
            {"id":"source","type_id":"source.constant","properties":{"value":"T"}},
            {"id":"probe","type_id":"sink.probe"}
        ],
        "connections": [{
            "id":"wire",
            "source_component_id":"source",
            "source_port_id":"out",
            "target_component_id":"probe",
            "target_port_id":"in"
        }]
    }"#;
    let circuit: CircuitDefinition = serde_json::from_str(circuit_json).unwrap();
    assert_eq!(
        circuit.components[1].properties,
        ComponentProperties::default()
    );
    let circuit_round_trip: CircuitDefinition =
        serde_json::from_str(&serde_json::to_string(&circuit).unwrap()).unwrap();
    assert_eq!(circuit_round_trip, circuit);

    let diagnostic = Diagnostic {
        code: "DUPLICATE_CONNECTION".to_owned(),
        severity: DiagnosticSeverity::Warning,
        message: "duplicate endpoint".to_owned(),
        component_ids: vec!["source".to_owned(), "probe".to_owned()],
        connection_ids: vec!["a".to_owned(), "b".to_owned()],
        port_ids: vec!["out".to_owned(), "in".to_owned()],
    };
    let diagnostic_json = serde_json::to_string(&diagnostic).unwrap();
    assert!(diagnostic_json.contains(r#""severity":"warning""#));
    let diagnostic_round_trip: Diagnostic = serde_json::from_str(&diagnostic_json).unwrap();
    assert_eq!(diagnostic_round_trip, diagnostic);
}

#[test]
fn reversing_input_arrays_preserves_validated_graph_and_diagnostic_order() {
    let components = vec![
        component("source-b", "source.constant"),
        component("probe", "sink.probe"),
        component("source-a", "source.trit_input"),
    ];
    let connections = vec![
        connection("z-duplicate", "source-a", "out", "probe", "in"),
        connection("driver-b", "source-b", "out", "probe", "in"),
        connection("a-duplicate", "source-a", "out", "probe", "in"),
    ];
    let mut reversed_components = components.clone();
    reversed_components.reverse();
    let mut reversed_connections = connections.clone();
    reversed_connections.reverse();

    let forward = validate_circuit(definition(components, connections)).unwrap();
    let reversed = validate_circuit(definition(reversed_components, reversed_connections)).unwrap();

    assert_eq!(forward.circuit.components(), reversed.circuit.components());
    assert_eq!(
        forward.circuit.connections(),
        reversed.circuit.connections()
    );
    assert_eq!(
        forward.circuit.drivers_for("probe", "in"),
        reversed.circuit.drivers_for("probe", "in")
    );
    assert_eq!(forward.warnings, reversed.warnings);

    let invalid_components = vec![
        component("z-unknown", "unknown.z"),
        component("a-unknown", "unknown.a"),
    ];
    let mut reversed_invalid_components = invalid_components.clone();
    reversed_invalid_components.reverse();
    let forward_diagnostics = validate_circuit(definition(invalid_components, vec![])).unwrap_err();
    let reversed_diagnostics =
        validate_circuit(definition(reversed_invalid_components, vec![])).unwrap_err();

    assert_eq!(forward_diagnostics, reversed_diagnostics);
    assert_eq!(
        forward_diagnostics
            .iter()
            .map(|diagnostic| diagnostic.component_ids.as_slice())
            .collect::<Vec<_>>(),
        vec![["a-unknown"].as_slice(), ["z-unknown"].as_slice()]
    );
}
