use sim_core::catalog::PortDirection;
use sim_core::connectivity::compile_project_v3;
use sim_core::project::{
    ProjectCircuitKind, ProjectCircuitV3, ProjectComponent, ProjectDocumentV3, ProjectProperties,
    ProjectWire, QualifiedComponentRef, QualifiedPortRef, WireEndpoint,
};
use sim_core::project_simulator::ProjectSimulator;
use sim_core::project_validation::resolve_project_ports;
use sim_core::simulator::ClockPhase;
use sim_core::trace::{TraceSignalRef, TraceWatch};

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

fn project(components: Vec<ProjectComponent>, wires: Vec<ProjectWire>) -> ProjectDocumentV3 {
    ProjectDocumentV3 {
        format: "logsim-ternary".into(),
        version: 3,
        root_circuit_id: "main".into(),
        circuits: vec![ProjectCircuitV3 {
            id: "main".into(),
            name: "Memory".into(),
            kind: ProjectCircuitKind::Main,
            components,
            wires,
        }],
    }
}

fn rom_contents() -> Vec<String> {
    let mut contents = vec!["000".to_owned(); 23];
    contents[4] = "1T0".into();
    contents[13] = "T01".into();
    contents[22] = "11T".into();
    contents
}

fn rom_project(label: &str, contents: Vec<String>) -> ProjectDocumentV3 {
    project(
        vec![
            component(
                "addr",
                "source.trit_input",
                serde_json::json!({"width": 3, "value": "T00"}),
            ),
            component(
                "rom",
                "memory.rom",
                serde_json::json!({
                    "label": label,
                    "wordWidth": 3,
                    "addressWidth": 3,
                    "contents": contents,
                }),
            ),
            component("probe", "sink.probe", serde_json::json!({"width": 3})),
        ],
        vec![
            wire("addr-rom", "addr", "out", "rom", "addr"),
            wire("rom-probe", "rom", "data", "probe", "in"),
        ],
    )
}

fn ram_project(label: &str, word_width: u8, data: &str) -> ProjectDocumentV3 {
    project(
        vec![
            component(
                "addr",
                "source.trit_input",
                serde_json::json!({"width": 3, "value": "000"}),
            ),
            component(
                "din",
                "source.trit_input",
                serde_json::json!({"width": word_width, "value": data}),
            ),
            component("we", "source.trit_input", serde_json::json!({"value": "1"})),
            component("clock", "source.clock", serde_json::json!({})),
            component(
                "rst",
                "source.trit_input",
                serde_json::json!({"value": "0"}),
            ),
            component(
                "ram",
                "memory.ram",
                serde_json::json!({
                    "label": label,
                    "wordWidth": word_width,
                    "addressWidth": 3,
                }),
            ),
            component(
                "probe",
                "sink.probe",
                serde_json::json!({"width": word_width}),
            ),
        ],
        vec![
            wire("addr-ram", "addr", "out", "ram", "addr"),
            wire("din-ram", "din", "out", "ram", "din"),
            wire("we-ram", "we", "out", "ram", "we"),
            wire("clock-ram", "clock", "out", "ram", "clk"),
            wire("rst-ram", "rst", "out", "ram", "rst"),
            wire("ram-probe", "ram", "dout", "probe", "in"),
        ],
    )
}

fn watch(component_id: &str, port_id: &str) -> TraceWatch {
    TraceWatch {
        id: format!("{component_id}-{port_id}"),
        signal: TraceSignalRef::ComponentPort(QualifiedPortRef::new(
            "main",
            [] as [&str; 0],
            component_id,
            port_id,
        )),
    }
}

#[test]
fn public_memory_ports_resolve_with_defaults_and_exact_dynamic_shapes() {
    let rom_default = resolve_project_ports("memory.rom", &properties(serde_json::json!({})))
        .expect("default ROM ports");
    assert_eq!(
        rom_default
            .iter()
            .map(|port| (port.id.as_str(), port.direction, port.shape.width()))
            .collect::<Vec<_>>(),
        vec![
            ("addr", PortDirection::Input, 3),
            ("data", PortDirection::Output, 3)
        ]
    );

    let ram = resolve_project_ports(
        "memory.ram",
        &properties(serde_json::json!({"wordWidth": 27, "addressWidth": 1})),
    )
    .expect("RAM ports");
    assert_eq!(
        ram.iter()
            .map(|port| (port.id.as_str(), port.direction, port.shape.width()))
            .collect::<Vec<_>>(),
        vec![
            ("addr", PortDirection::Input, 1),
            ("din", PortDirection::Input, 27),
            ("we", PortDirection::Input, 1),
            ("clk", PortDirection::Input, 1),
            ("rst", PortDirection::Input, 1),
            ("dout", PortDirection::Output, 27),
        ]
    );
}

#[test]
fn memory_properties_fail_with_stable_codes_before_lowering() {
    for address_width in [0, 4] {
        let error = resolve_project_ports(
            "memory.ram",
            &properties(serde_json::json!({"addressWidth": address_width})),
        )
        .expect_err("invalid address width");
        assert_eq!(error.code(), "INVALID_MEMORY_ADDRESS_WIDTH");
    }

    for bad_contents in [
        serde_json::json!(["00"]),
        serde_json::json!(["00X"]),
        serde_json::json!(["000", "000", "000", "000"]),
    ] {
        let error = resolve_project_ports(
            "memory.rom",
            &properties(serde_json::json!({
                "wordWidth": 3,
                "addressWidth": 1,
                "contents": bad_contents,
            })),
        )
        .expect_err("invalid contents");
        assert_eq!(error.code(), "INVALID_MEMORY_CONTENTS");
    }

    let diagnostics = compile_project_v3(
        project(
            vec![component(
                "private",
                "internal.ram_cell",
                serde_json::json!({"addressWidth": 1}),
            )],
            vec![],
        ),
        "main",
    )
    .expect_err("internal cells are not user-placeable");
    assert_eq!(diagnostics[0].code, "INTERNAL_COMPONENT_NOT_PUBLIC");
}

#[test]
fn rom_lowers_to_lane_cells_with_ms_first_addresses_contents_and_provenance() {
    let compiled =
        compile_project_v3(rom_project("Program", rom_contents()), "main").expect("ROM compiles");
    let lowered = &compiled.lowered.project.circuits[0];
    let cells = lowered
        .components
        .iter()
        .filter(|component| component.type_id == "internal.rom_cell")
        .collect::<Vec<_>>();
    assert_eq!(cells.len(), 3);
    assert_eq!(
        cells
            .iter()
            .map(|cell| cell.id.as_str())
            .collect::<Vec<_>>(),
        vec!["rom#rom#bit0", "rom#rom#bit1", "rom#rom#bit2"]
    );

    let macro_ref = QualifiedComponentRef::new("main", [] as [&str; 0], "rom");
    for (lane, cell) in cells.iter().enumerate() {
        let cell_ref = QualifiedComponentRef::new("main", [] as [&str; 0], &cell.id);
        assert_eq!(compiled.lowered.provenance.components[&cell_ref], macro_ref);
        assert_eq!(
            cell.properties.get("addressWidth").and_then(|v| v.as_u64()),
            Some(3)
        );
        let lane_contents = cell.properties.get("contents").unwrap().as_array().unwrap();
        assert_eq!(lane_contents[4].as_str(), Some(["0", "T", "1"][lane]));
        assert_eq!(lane_contents[13].as_str(), Some(["1", "0", "T"][lane]));
        assert_eq!(lane_contents[22].as_str(), Some(["T", "1", "1"][lane]));
        for port_id in ["addr0", "addr1", "addr2", "q"] {
            assert_eq!(
                compiled.lowered.provenance.ports
                    [&QualifiedPortRef::new("main", [] as [&str; 0], &cell.id, port_id,)]
                    .component_id,
                "rom"
            );
        }
    }

    let cell_connections = |port_id: &str| {
        lowered
            .connections
            .iter()
            .filter(|connection| connection.target_port_id == port_id)
            .count()
    };
    assert_eq!(cell_connections("addr0"), 3);
    assert_eq!(cell_connections("addr1"), 3);
    assert_eq!(cell_connections("addr2"), 3);
}

#[test]
fn rom_reads_t00_zero_and_100_and_public_watch_reassembles_ms_first() {
    let mut simulator =
        ProjectSimulator::load_v3(rom_project("Program", rom_contents()), "main").unwrap();
    simulator
        .set_trace_watches(vec![watch("rom", "data")])
        .unwrap();
    assert_eq!(
        simulator.snapshot().unwrap().component_output_words["rom"]["data"].to_string(),
        "1T0"
    );

    let zero = simulator.set_source_word("main", "addr", "000").unwrap();
    assert_eq!(
        zero.component_output_words["rom"]["data"].to_string(),
        "T01"
    );
    let positive = simulator.set_source_word("main", "addr", "100").unwrap();
    assert_eq!(
        positive.component_output_words["rom"]["data"].to_string(),
        "11T"
    );
    assert_eq!(
        simulator.trace_frames().back().unwrap().values[0]
            .value
            .to_string(),
        "11T"
    );
}

#[test]
fn ram_label_edit_preserves_state_and_phase_but_structural_edit_rebuilds() {
    let initial = ram_project("Data", 3, "1T0");
    let mut simulator = ProjectSimulator::load_v3(initial.clone(), "main").unwrap();
    simulator
        .set_trace_watches(vec![watch("ram", "dout")])
        .unwrap();
    let written = simulator.advance_phase().unwrap();
    assert_eq!(written.clock_phase, ClockPhase::HighStable);
    assert_eq!(
        written.component_output_words["ram"]["dout"].to_string(),
        "1T0"
    );

    let retained = simulator
        .update_project_v3(ram_project("Renamed Data", 3, "1T0"))
        .unwrap();
    assert_eq!(retained.compile_count, 1);
    assert_eq!(retained.clock_phase, ClockPhase::HighStable);
    assert_eq!(
        retained.component_output_words["ram"]["dout"].to_string(),
        "1T0"
    );

    let rebuilt = simulator
        .update_project_v3(ram_project("Renamed Data", 1, "T"))
        .unwrap();
    assert_eq!(rebuilt.compile_count, 2);
    assert_eq!(rebuilt.clock_phase, ClockPhase::LowStable);
    assert_eq!(
        rebuilt.component_output_words["ram"]["dout"].to_string(),
        "0"
    );
    assert_eq!(simulator.trace_frames().len(), 1);
}

#[test]
fn rom_contents_edit_recompiles_resets_phase_and_keeps_rom_immutable_on_reset() {
    let mut simulator =
        ProjectSimulator::load_v3(rom_project("Program", rom_contents()), "main").unwrap();
    simulator
        .set_trace_watches(vec![watch("rom", "data")])
        .unwrap();
    simulator.advance_phase().unwrap();

    let mut changed = rom_contents();
    changed[4] = "TT1".into();
    let rebuilt = simulator
        .update_project_v3(rom_project("Program", changed))
        .unwrap();
    assert_eq!(rebuilt.compile_count, 2);
    assert_eq!(rebuilt.clock_phase, ClockPhase::LowStable);
    assert_eq!(
        rebuilt.component_output_words["rom"]["data"].to_string(),
        "TT1"
    );
    assert_eq!(simulator.trace_frames().len(), 1);

    let reset = simulator.reset().unwrap();
    assert_eq!(
        reset.component_output_words["rom"]["data"].to_string(),
        "TT1"
    );
}
