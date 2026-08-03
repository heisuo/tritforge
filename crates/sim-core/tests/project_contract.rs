use sim_core::diagnostic::Severity;
use sim_core::project::{
    ProjectCircuit, ProjectCircuitKind, ProjectComponent, ProjectDiagnostic, ProjectDiagnosticSet,
    ProjectDocument, ProjectLocation, QualifiedComponentRef, QualifiedConnectionRef,
    QualifiedPortRef,
};
use sim_core::trit::Trit;

#[test]
fn project_v2_round_trips_extension_properties() {
    let project = ProjectDocument {
        format: "logsim-ternary".into(),
        version: 2,
        root_circuit_id: "main".into(),
        circuits: vec![ProjectCircuit {
            id: "main".into(),
            name: "Main".into(),
            kind: ProjectCircuitKind::Main,
            components: vec![
                ProjectComponent::new(
                    "input-1",
                    "source.trit_input",
                    serde_json::json!({
                        "value": "0",
                        "moduleId": 123,
                        "extension": {"enabled": true}
                    }),
                )
                .unwrap(),
            ],
            connections: vec![],
        }],
    };

    let restored: ProjectDocument =
        serde_json::from_str(&serde_json::to_string(&project).unwrap()).unwrap();

    assert_eq!(restored, project);
    let properties = &restored.circuits[0].components[0].properties;
    assert_eq!(properties.known_value(), Some(Trit::Zero));
    assert_eq!(properties.module_id(), None);
    assert_eq!(properties.get("moduleId"), Some(&serde_json::json!(123)));
    assert_eq!(
        properties.get("extension"),
        Some(&serde_json::json!({"enabled": true}))
    );
}

#[test]
fn project_properties_reject_non_object_values() {
    let error =
        ProjectComponent::new("input-1", "source.trit_input", serde_json::json!(0)).unwrap_err();

    assert_eq!(
        error.to_string(),
        "project component properties must be an object"
    );
}

#[test]
fn project_components_require_an_explicit_properties_object() {
    let missing_properties = serde_json::json!({
        "id": "input-1",
        "typeId": "source.trit_input"
    });

    assert!(serde_json::from_value::<ProjectComponent>(missing_properties).is_err());
}

#[test]
fn typed_property_accessors_accept_only_expected_types_and_known_trits() {
    let component = ProjectComponent::new(
        "boundary-1",
        "project.module_input",
        serde_json::json!({
            "portId": "a",
            "label": "Input A",
            "previewValue": "T",
            "value": "X"
        }),
    )
    .unwrap();

    assert_eq!(component.properties.port_id(), Some("a"));
    assert_eq!(component.properties.label(), Some("Input A"));
    assert_eq!(component.properties.preview_value(), Some(Trit::Neg));
    assert_eq!(component.properties.known_value(), None);
}

#[test]
fn qualified_refs_include_their_own_scope() {
    let parent = QualifiedComponentRef::new("main", ["fa-1"], "input-a");
    let child = QualifiedComponentRef::new("half-adder", ["fa-1", "ha-1"], "input-a");
    let connection = QualifiedConnectionRef::new("full-adder", ["fa-1"], "wire-1");
    let port = QualifiedPortRef::new("half-adder", ["fa-1", "ha-1"], "sum", "out");

    assert_ne!(parent, child);
    assert_eq!(connection.circuit_id, "full-adder");
    assert_eq!(port.instance_path, vec!["fa-1", "ha-1"]);
}

#[test]
fn project_diagnostics_have_stable_ordering_and_qualified_locations() {
    let port = QualifiedPortRef::new("half-adder", ["fa-1", "ha-1"], "sum", "out");
    let other_port = QualifiedPortRef::new("full-adder", ["fa-1"], "carry", "out");
    let later_location = ProjectDiagnostic {
        code: "ALPHA".into(),
        severity: Severity::Error,
        message: "qualified failure".into(),
        primary_location: Some(ProjectLocation::Port(port.clone())),
        component_refs: vec![],
        connection_refs: vec![],
        port_refs: vec![port.clone(), other_port.clone()],
    };
    let mut diagnostics = [
        later_location.clone(),
        ProjectDiagnostic {
            code: "ZULU".into(),
            message: "earlier location".into(),
            primary_location: Some(ProjectLocation::Port(other_port.clone())),
            port_refs: vec![other_port.clone()],
            ..later_location.clone()
        },
    ];
    diagnostics.sort();

    assert_eq!(diagnostics[0].code, "ALPHA");

    let same_identity = ProjectDiagnostic {
        message: "translated message".into(),
        primary_location: None,
        port_refs: vec![other_port, port],
        ..later_location.clone()
    };
    assert_eq!(later_location.dedup_key(), same_identity.dedup_key());

    let mut forward = ProjectDiagnosticSet::new();
    forward.insert(later_location.clone());
    forward.insert(same_identity.clone());
    let mut reverse = ProjectDiagnosticSet::new();
    reverse.insert(same_identity);
    reverse.insert(later_location);

    assert_eq!(forward, reverse);
    assert_eq!(
        serde_json::to_string(&forward.into_vec()).unwrap(),
        serde_json::to_string(&reverse.into_vec()).unwrap()
    );
}

#[test]
fn diagnostic_set_orders_ports_before_unrelated_connection_ids() {
    let diagnostic = |port_id: &str, connection_id: &str| ProjectDiagnostic {
        code: "INVALID_PORT".into(),
        severity: Severity::Error,
        message: port_id.into(),
        primary_location: None,
        component_refs: vec![QualifiedComponentRef::new("main", [] as [&str; 0], "gate")],
        connection_refs: vec![QualifiedConnectionRef::new(
            "main",
            [] as [&str; 0],
            connection_id,
        )],
        port_refs: vec![QualifiedPortRef::new(
            "main",
            [] as [&str; 0],
            "gate",
            port_id,
        )],
    };
    let mut diagnostics = ProjectDiagnosticSet::new();
    diagnostics.insert(diagnostic("z", "a-connection"));
    diagnostics.insert(diagnostic("a", "z-connection"));

    let ordered = diagnostics.into_vec();
    assert_eq!(ordered[0].port_refs[0].port_id, "a");
    assert_eq!(ordered[1].port_refs[0].port_id, "z");
}

#[test]
fn project_wire_format_uses_camel_case_and_tagged_locations() {
    let component = ProjectComponent::new(
        "instance-1",
        "project.module_instance",
        serde_json::json!({"moduleId": "half-adder"}),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(component).unwrap(),
        serde_json::json!({
            "id": "instance-1",
            "typeId": "project.module_instance",
            "properties": {"moduleId": "half-adder"}
        })
    );

    let location =
        ProjectLocation::Port(QualifiedPortRef::new("half-adder", ["ha-1"], "sum", "out"));
    assert_eq!(
        serde_json::to_value(location).unwrap(),
        serde_json::json!({
            "kind": "port",
            "ref": {
                "circuitId": "half-adder",
                "instancePath": ["ha-1"],
                "componentId": "sum",
                "portId": "out"
            }
        })
    );
}
