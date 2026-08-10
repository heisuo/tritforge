use sim_core::catalog::PortDirection;
use sim_core::project::{
    ProjectCircuitKind, ProjectCircuitV3, ProjectComponent, ProjectDocumentV3, ProjectProperties,
    ProjectWire, WireEndpoint,
};
use sim_core::project_validation::resolve_project_ports;
use sim_core::signal::{KnownWord, SignalShape, WordValue};
use sim_core::trit::Trit;

fn properties(value: serde_json::Value) -> ProjectProperties {
    ProjectProperties::from_value(value).unwrap()
}

fn resolved_shapes(type_id: &str, value: serde_json::Value) -> Vec<(String, PortDirection, u8)> {
    resolve_project_ports(type_id, &properties(value))
        .unwrap()
        .into_iter()
        .map(|port| (port.id, port.direction, port.shape.width()))
        .collect()
}

#[test]
fn inout_port_direction_has_stable_snake_case_serde() {
    assert_eq!(
        serde_json::to_string(&PortDirection::InOut).unwrap(),
        r#""in_out""#
    );
    assert_eq!(
        serde_json::from_str::<PortDirection>(r#""in_out""#).unwrap(),
        PortDirection::InOut
    );
}

#[test]
fn resolved_ports_default_legacy_widths_and_accept_supported_widths() {
    for width in [1, 3, 27] {
        assert_eq!(
            resolved_shapes(
                "source.trit_input",
                serde_json::json!({"width": width, "value": "0".repeat(width)})
            ),
            vec![("out".into(), PortDirection::Output, width as u8)]
        );
    }

    assert_eq!(
        resolved_shapes("sink.probe", serde_json::json!({})),
        vec![("in".into(), PortDirection::Input, 1)]
    );
}

#[test]
fn resolved_ports_reject_widths_outside_the_supported_range() {
    for width in [0, 28] {
        for type_id in [
            "source.constant",
            "sink.probe",
            "project.module_input",
            "project.module_output",
            "wiring.junction",
            "wiring.tunnel",
            "wiring.splitter",
        ] {
            let mut value = serde_json::json!({"width": width});
            if type_id == "project.module_input" {
                value["portId"] = serde_json::json!("a");
                value["label"] = serde_json::json!("A");
                value["previewValue"] = serde_json::json!("0");
            } else if type_id == "project.module_output" {
                value["portId"] = serde_json::json!("y");
                value["label"] = serde_json::json!("Y");
            } else if type_id == "wiring.tunnel" {
                value["label"] = serde_json::json!("bus");
            } else if type_id == "wiring.splitter" {
                value["branchCount"] = serde_json::json!(1);
                value["mapping"] = serde_json::json!([]);
            }

            let error = resolve_project_ports(type_id, &properties(value)).unwrap_err();
            assert_eq!(error.code(), "INVALID_SIGNAL_WIDTH", "{type_id}");
        }
    }
}

#[test]
fn resolved_ports_apply_widths_to_sources_probes_and_module_boundaries() {
    assert_eq!(
        resolved_shapes(
            "source.constant",
            serde_json::json!({"width": 3, "value": "1T0"})
        ),
        vec![("out".into(), PortDirection::Output, 3)]
    );
    assert_eq!(
        resolved_shapes("sink.probe", serde_json::json!({"width": 3})),
        vec![("in".into(), PortDirection::Input, 3)]
    );
    assert_eq!(
        resolved_shapes(
            "project.module_input",
            serde_json::json!({
                "portId": "a",
                "label": "A",
                "previewValue": "1T0",
                "width": 3
            })
        ),
        vec![("out".into(), PortDirection::Output, 3)]
    );
    assert_eq!(
        resolved_shapes(
            "project.module_output",
            serde_json::json!({"portId": "y", "label": "Y", "width": 3})
        ),
        vec![("in".into(), PortDirection::Input, 3)]
    );
}

#[test]
fn resolved_ports_validate_width_aware_words_and_property_allowlists() {
    for value in ["1T", "1T00", "1X0"] {
        let error = resolve_project_ports(
            "source.constant",
            &properties(serde_json::json!({"width": 3, "value": value})),
        )
        .unwrap_err();
        assert_eq!(error.code(), "INVALID_PROPERTY");
    }

    let error = resolve_project_ports(
        "project.module_input",
        &properties(serde_json::json!({
            "portId": "a",
            "label": "A",
            "previewValue": "10",
            "width": 3
        })),
    )
    .unwrap_err();
    assert_eq!(error.code(), "INVALID_PROPERTY");

    for (type_id, value) in [
        ("sink.probe", serde_json::json!({"value": "0"})),
        (
            "project.module_output",
            serde_json::json!({"portId": "y", "label": "Y", "value": "0"}),
        ),
    ] {
        assert_eq!(
            resolve_project_ports(type_id, &properties(value))
                .unwrap_err()
                .code(),
            "INVALID_PROPERTY"
        );
    }

    for (type_id, value) in [
        ("source.trit_input", serde_json::json!({"extension": true})),
        (
            "wiring.junction",
            serde_json::json!({"width": 1, "extension": true}),
        ),
        (
            "wiring.tunnel",
            serde_json::json!({"label": "data", "width": 1, "extension": true}),
        ),
        (
            "wiring.splitter",
            serde_json::json!({
                "extension": true,
                "width": 1,
                "branchCount": 1,
                "mapping": [0]
            }),
        ),
    ] {
        assert_eq!(
            resolve_project_ports(type_id, &properties(value))
                .unwrap_err()
                .code(),
            "INVALID_PROPERTY"
        );
    }
}

#[test]
fn resolved_ports_build_junction_and_exact_tunnel_ports() {
    assert_eq!(
        resolved_shapes(
            "wiring.junction",
            serde_json::json!({"label": "branch point", "width": 3})
        ),
        vec![("net".into(), PortDirection::InOut, 3)]
    );
    assert_eq!(
        resolved_shapes(
            "wiring.tunnel",
            serde_json::json!({"label": "Data", "width": 3})
        ),
        vec![("net".into(), PortDirection::InOut, 3)]
    );

    for label in [serde_json::json!(""), serde_json::json!(4)] {
        let error = resolve_project_ports(
            "wiring.tunnel",
            &properties(serde_json::json!({"label": label, "width": 3})),
        )
        .unwrap_err();
        assert_eq!(error.code(), "INVALID_PROPERTY");
    }
}

#[test]
fn resolved_ports_build_ordered_uniform_and_nonuniform_splitters() {
    assert_eq!(
        resolved_shapes(
            "wiring.splitter",
            serde_json::json!({
                "label": "three-way",
                "width": 3,
                "branchCount": 3,
                "mapping": [0, 1, 2]
            })
        ),
        vec![
            ("trunk".into(), PortDirection::InOut, 3),
            ("branch0".into(), PortDirection::InOut, 1),
            ("branch1".into(), PortDirection::InOut, 1),
            ("branch2".into(), PortDirection::InOut, 1),
        ]
    );
    assert_eq!(
        resolved_shapes(
            "wiring.splitter",
            serde_json::json!({
                "width": 6,
                "branchCount": 3,
                "mapping": [0, 0, 1, 1, 1, 2]
            })
        ),
        vec![
            ("trunk".into(), PortDirection::InOut, 6),
            ("branch0".into(), PortDirection::InOut, 2),
            ("branch1".into(), PortDirection::InOut, 3),
            ("branch2".into(), PortDirection::InOut, 1),
        ]
    );
}

#[test]
fn resolved_ports_reject_invalid_optional_splitter_labels() {
    for label in [serde_json::json!(""), serde_json::json!(4)] {
        let error = resolve_project_ports(
            "wiring.splitter",
            &properties(serde_json::json!({
                "label": label,
                "width": 1,
                "branchCount": 1,
                "mapping": [0]
            })),
        )
        .unwrap_err();

        assert_eq!(error.code(), "INVALID_PROPERTY");
    }
}

#[test]
fn resolved_ports_reject_every_malformed_splitter_mapping_without_panicking() {
    for value in [
        serde_json::json!({"width": 3, "branchCount": 3, "mapping": [0, 1]}),
        serde_json::json!({"width": 3, "branchCount": 2, "mapping": [0, -1, 1]}),
        serde_json::json!({"width": 3, "branchCount": 2, "mapping": [0, 0.5, 1]}),
        serde_json::json!({"width": 3, "branchCount": 2, "mapping": [0, 2, 1]}),
        serde_json::json!({"width": 3, "branchCount": 3, "mapping": [0, 0, 2]}),
        serde_json::json!({"width": 3, "branchCount": 0, "mapping": [0, 0, 0]}),
        serde_json::json!({"width": 3, "branchCount": 4, "mapping": [0, 1, 2]}),
    ] {
        let error = resolve_project_ports("wiring.splitter", &properties(value)).unwrap_err();
        assert_eq!(error.code(), "INVALID_SPLITTER_MAP");
    }
}

#[test]
fn signal_shape_checks_supported_widths_and_has_stable_serde() {
    for width in [1, 3, 27] {
        let shape = SignalShape::new(width).unwrap();

        assert_eq!(shape.width(), width);
        assert_eq!(serde_json::to_string(&shape).unwrap(), width.to_string());
        assert_eq!(
            serde_json::from_str::<SignalShape>(&width.to_string()).unwrap(),
            shape
        );
    }

    assert!(SignalShape::new(0).is_err());
    assert!(SignalShape::new(28).is_err());
    assert!(serde_json::from_str::<SignalShape>("0").is_err());
    assert!(serde_json::from_str::<SignalShape>("28").is_err());
}

#[test]
fn known_words_require_the_declared_width_and_known_symbols() {
    let shape = SignalShape::new(3).unwrap();

    assert!(KnownWord::parse("1T", shape).is_err());
    assert!(KnownWord::parse("1T00", shape).is_err());
    for symbol in ['X', 'Z', 'E', '?'] {
        assert!(KnownWord::parse(&format!("1{symbol}0"), shape).is_err());
    }
}

#[test]
fn known_words_display_most_significant_first_and_index_least_significant_first() {
    let shape = SignalShape::new(3).unwrap();
    let word = KnownWord::parse("1T0", shape).unwrap();

    assert_eq!(word.shape(), shape);
    assert_eq!(word.trit(0), Trit::Zero);
    assert_eq!(word.trit(1), Trit::Neg);
    assert_eq!(word.trit(2), Trit::Pos);
    assert_eq!(word.balanced_value(), 6);
    assert_eq!(word.to_string(), "1T0");
}

#[test]
fn known_words_support_width_27_without_overflow() {
    let shape = SignalShape::new(27).unwrap();
    let maximum = KnownWord::parse("111111111111111111111111111", shape).unwrap();
    let minimum = KnownWord::parse("TTTTTTTTTTTTTTTTTTTTTTTTTTT", shape).unwrap();

    assert_eq!(maximum.balanced_value(), 3_812_798_742_493_i64);
    assert_eq!(minimum.balanced_value(), -3_812_798_742_493_i64);
}

#[test]
fn known_words_serialize_as_stable_most_significant_first_strings() {
    let word = KnownWord::parse("1T0", SignalShape::new(3).unwrap()).unwrap();
    let encoded = serde_json::to_string(&word).unwrap();

    assert_eq!(encoded, r#""1T0""#);
    assert_eq!(serde_json::from_str::<KnownWord>(&encoded).unwrap(), word);
}

#[test]
fn runtime_words_enforce_shape_and_preserve_meta_values() {
    let shape = SignalShape::new(6).unwrap();
    let trits = vec![
        Trit::Neg,
        Trit::Zero,
        Trit::Error,
        Trit::HighZ,
        Trit::Unknown,
        Trit::Pos,
    ];
    let word = WordValue::new(shape, trits).unwrap();

    assert_eq!(word.shape(), shape);
    assert_eq!(word.trit(0), Trit::Neg);
    assert_eq!(word.trit(1), Trit::Zero);
    assert_eq!(word.trit(2), Trit::Error);
    assert_eq!(word.trit(3), Trit::HighZ);
    assert_eq!(word.trit(4), Trit::Unknown);
    assert_eq!(word.trit(5), Trit::Pos);
    assert!(WordValue::new(shape, vec![Trit::Zero; 5]).is_err());
    assert!(WordValue::new(shape, vec![Trit::Zero; 7]).is_err());
}

#[test]
fn runtime_words_serialize_as_stable_most_significant_first_strings() {
    let word = WordValue::new(
        SignalShape::new(6).unwrap(),
        vec![
            Trit::Neg,
            Trit::Zero,
            Trit::Error,
            Trit::HighZ,
            Trit::Unknown,
            Trit::Pos,
        ],
    )
    .unwrap();
    let encoded = serde_json::to_string(&word).unwrap();

    assert_eq!(encoded, r#""1XZE0T""#);
    assert_eq!(serde_json::from_str::<WordValue>(&encoded).unwrap(), word);
    assert!(serde_json::from_str::<WordValue>(r#""""#).is_err());
    assert!(serde_json::from_str::<WordValue>(r#""222""#).is_err());
}

#[test]
fn project_v3_wire_migration_contract_has_stable_camel_case_serde() {
    let project = ProjectDocumentV3 {
        format: "logsim-ternary".into(),
        version: 3,
        root_circuit_id: "main".into(),
        circuits: vec![ProjectCircuitV3 {
            id: "main".into(),
            name: "Main".into(),
            kind: ProjectCircuitKind::Main,
            components: vec![
                ProjectComponent::new(
                    "input-1",
                    "source.trit_input",
                    serde_json::json!({"value": "0", "extension": {"keep": true}}),
                )
                .unwrap(),
                ProjectComponent::new("probe-1", "sink.probe", serde_json::json!({})).unwrap(),
            ],
            wires: vec![ProjectWire {
                id: "wire-1".into(),
                endpoint_a: WireEndpoint {
                    component_id: "input-1".into(),
                    port_id: "out".into(),
                },
                endpoint_b: WireEndpoint {
                    component_id: "probe-1".into(),
                    port_id: "in".into(),
                },
            }],
        }],
    };

    let encoded = serde_json::to_value(&project).unwrap();

    assert_eq!(
        encoded,
        serde_json::json!({
            "format": "logsim-ternary",
            "version": 3,
            "rootCircuitId": "main",
            "circuits": [{
                "id": "main",
                "name": "Main",
                "kind": "main",
                "components": [
                    {
                        "id": "input-1",
                        "typeId": "source.trit_input",
                        "properties": {"value": "0", "extension": {"keep": true}}
                    },
                    {
                        "id": "probe-1",
                        "typeId": "sink.probe",
                        "properties": {}
                    }
                ],
                "wires": [{
                    "id": "wire-1",
                    "endpointA": {"componentId": "input-1", "portId": "out"},
                    "endpointB": {"componentId": "probe-1", "portId": "in"}
                }]
            }]
        })
    );
    assert_eq!(
        serde_json::from_value::<ProjectDocumentV3>(encoded).unwrap(),
        project
    );
}

#[test]
fn project_v3_checked_parser_rejects_wrong_versions_and_connections() {
    let wrong_version = serde_json::json!({
        "format": "logsim-ternary",
        "version": 2,
        "rootCircuitId": "main",
        "circuits": []
    });
    let mixed_schema = serde_json::json!({
        "format": "logsim-ternary",
        "version": 3,
        "rootCircuitId": "main",
        "circuits": [{
            "id": "main",
            "name": "Main",
            "kind": "main",
            "components": [],
            "wires": [],
            "connections": []
        }]
    });

    assert!(
        ProjectDocumentV3::parse_json(&wrong_version.to_string())
            .unwrap_err()
            .to_string()
            .contains("version 2")
    );
    assert!(ProjectDocumentV3::parse_json(&mixed_schema.to_string()).is_err());
}

#[test]
fn project_v3_checked_parser_requires_the_format_header() {
    let valid = serde_json::json!({
        "format": "logsim-ternary",
        "version": 3,
        "rootCircuitId": "main",
        "circuits": [{
            "id": "main",
            "name": "Main",
            "kind": "main",
            "components": [],
            "wires": []
        }]
    });
    let mut wrong_format = valid.clone();
    wrong_format["format"] = serde_json::json!("another-format");

    assert!(ProjectDocumentV3::parse_json(&valid.to_string()).is_ok());
    assert!(
        ProjectDocumentV3::parse_json(&wrong_format.to_string())
            .unwrap_err()
            .to_string()
            .contains("another-format")
    );
}
