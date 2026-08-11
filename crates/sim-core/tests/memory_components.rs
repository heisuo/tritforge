use sim_core::catalog::{ComponentKind, ComponentProperties, component_catalog};
use sim_core::circuit::{CircuitDefinition, ComponentInstance, Connection, validate_circuit};
use sim_core::memory::{DecodedAddress, decode_balanced_address};
use sim_core::simulator::{ClockPhase, Simulator};
use sim_core::trit::Trit;

fn component(id: &str, type_id: &str) -> ComponentInstance {
    ComponentInstance {
        id: id.into(),
        type_id: type_id.into(),
        properties: ComponentProperties::default(),
    }
}

fn source(id: &str, value: Trit) -> ComponentInstance {
    ComponentInstance {
        id: id.into(),
        type_id: "source.trit_input".into(),
        properties: ComponentProperties {
            value: Some(value),
            ..ComponentProperties::default()
        },
    }
}

fn memory_cell(
    id: &str,
    type_id: &str,
    address_width: u8,
    contents: Vec<Trit>,
) -> ComponentInstance {
    ComponentInstance {
        id: id.into(),
        type_id: type_id.into(),
        properties: ComponentProperties {
            address_width: Some(address_width),
            contents,
            ..ComponentProperties::default()
        },
    }
}

fn connection(
    id: &str,
    source: &str,
    source_port: &str,
    target: &str,
    target_port: &str,
) -> Connection {
    Connection {
        id: id.into(),
        source_component_id: source.into(),
        source_port_id: source_port.into(),
        target_component_id: target.into(),
        target_port_id: target_port.into(),
    }
}

fn wire(source: &str, target: &str, target_port: &str) -> Connection {
    connection(
        &format!("{source}-{target}-{target_port}"),
        source,
        "out",
        target,
        target_port,
    )
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

#[test]
fn balanced_addresses_are_decoded_ms_first_with_a_centered_offset() {
    fn known_trits(width: usize) -> Vec<Vec<Trit>> {
        let mut rows = vec![Vec::new()];
        for _ in 0..width {
            rows = rows
                .into_iter()
                .flat_map(|prefix| {
                    [Trit::Neg, Trit::Zero, Trit::Pos]
                        .into_iter()
                        .map(move |value| {
                            let mut row = prefix.clone();
                            row.push(value);
                            row
                        })
                })
                .collect();
        }
        rows
    }

    for width in 1_u8..=3 {
        for (expected, address) in known_trits(width.into()).into_iter().enumerate() {
            assert_eq!(
                decode_balanced_address(&address, width),
                DecodedAddress::Known(expected),
                "wrong AW={width} mapping for {address:?}"
            );
        }
    }

    assert_eq!(
        decode_balanced_address(&[Trit::Neg], 1),
        DecodedAddress::Known(0)
    );
    assert_eq!(
        decode_balanced_address(&[Trit::Zero], 1),
        DecodedAddress::Known(1)
    );
    assert_eq!(
        decode_balanced_address(&[Trit::Pos], 1),
        DecodedAddress::Known(2)
    );
    assert_eq!(
        decode_balanced_address(&[Trit::Neg, Trit::Neg], 2),
        DecodedAddress::Known(0)
    );
    assert_eq!(
        decode_balanced_address(&[Trit::Zero, Trit::Zero], 2),
        DecodedAddress::Known(4)
    );
    assert_eq!(
        decode_balanced_address(&[Trit::Pos, Trit::Pos], 2),
        DecodedAddress::Known(8)
    );
    assert_eq!(
        decode_balanced_address(&[Trit::Neg, Trit::Neg, Trit::Neg], 3),
        DecodedAddress::Known(0)
    );
    assert_eq!(
        decode_balanced_address(&[Trit::Zero, Trit::Zero, Trit::Zero], 3),
        DecodedAddress::Known(13)
    );
    assert_eq!(
        decode_balanced_address(&[Trit::Pos, Trit::Pos, Trit::Pos], 3),
        DecodedAddress::Known(26)
    );
}

#[test]
fn address_decoding_is_total_for_meta_values() {
    assert_eq!(
        decode_balanced_address(&[Trit::Unknown, Trit::Zero], 2),
        DecodedAddress::Unknown
    );
    assert_eq!(
        decode_balanced_address(&[Trit::HighZ, Trit::Pos], 2),
        DecodedAddress::Unknown
    );
    assert_eq!(
        decode_balanced_address(&[Trit::Unknown, Trit::Error], 2),
        DecodedAddress::Error
    );
}

#[test]
fn memory_kinds_are_recognized_but_are_not_public_catalog_entries() {
    assert_eq!(
        ComponentKind::from_type_id("memory.rom"),
        Some(ComponentKind::Rom)
    );
    assert_eq!(
        ComponentKind::from_type_id("memory.ram"),
        Some(ComponentKind::Ram)
    );
    assert_eq!(
        ComponentKind::from_type_id("internal.rom_cell"),
        Some(ComponentKind::InternalRomCell)
    );
    assert_eq!(
        ComponentKind::from_type_id("internal.ram_cell"),
        Some(ComponentKind::InternalRamCell)
    );

    let public_ids = component_catalog()
        .into_iter()
        .map(|descriptor| descriptor.type_id)
        .collect::<Vec<_>>();
    assert!(!public_ids.iter().any(|id| id.starts_with("internal.")));
    assert!(!public_ids.iter().any(|id| id.starts_with("memory.")));
}

#[test]
fn component_properties_keep_old_json_compatible_and_round_trip_cell_data() {
    let old: ComponentProperties = serde_json::from_str(r#"{"value":"1"}"#).unwrap();
    assert_eq!(old.value, Some(Trit::Pos));
    assert_eq!(old.address_width, None);
    assert!(old.contents.is_empty());

    let properties = ComponentProperties {
        address_width: Some(2),
        contents: vec![Trit::Neg, Trit::Zero, Trit::Pos],
        ..ComponentProperties::default()
    };
    let json = serde_json::to_string(&properties).unwrap();
    assert!(json.contains(r#""addressWidth":2"#));
    assert_eq!(
        serde_json::from_str::<ComponentProperties>(&json).unwrap(),
        properties
    );
}

#[test]
fn rom_reads_contents_asynchronously_and_zero_fills_the_remaining_depth() {
    let mut simulator = Simulator::load(definition(
        vec![
            source("a0", Trit::Neg),
            source("a1", Trit::Neg),
            memory_cell("rom", "internal.rom_cell", 2, vec![Trit::Neg, Trit::Pos]),
        ],
        vec![wire("a0", "rom", "addr0"), wire("a1", "rom", "addr1")],
    ))
    .expect("valid ROM cell");

    assert_eq!(
        simulator.snapshot().output_value("rom", "q"),
        Some(Trit::Neg)
    );

    let second = simulator
        .set_sources([("a0", Trit::Neg), ("a1", Trit::Zero)])
        .unwrap();
    assert_eq!(second.output_value("rom", "q"), Some(Trit::Pos));

    let zero_filled = simulator
        .set_sources([("a0", Trit::Zero), ("a1", Trit::Zero)])
        .unwrap();
    assert_eq!(zero_filled.output_value("rom", "q"), Some(Trit::Zero));

    let reset = simulator.reset();
    assert_eq!(reset.output_value("rom", "q"), Some(Trit::Neg));
}

#[test]
fn ram_writes_on_rise_holds_on_fall_and_reset_wins() {
    let mut simulator = Simulator::load(definition(
        vec![
            source("addr", Trit::Zero),
            source("data", Trit::Pos),
            source("we", Trit::Pos),
            source("rst", Trit::Zero),
            component("clock", "source.clock"),
            memory_cell("ram", "internal.ram_cell", 1, vec![]),
        ],
        vec![
            wire("addr", "ram", "addr0"),
            wire("data", "ram", "d"),
            wire("we", "ram", "we"),
            wire("rst", "ram", "rst"),
            wire("clock", "ram", "clk"),
        ],
    ))
    .expect("valid RAM cell");

    assert_eq!(
        simulator.snapshot().output_value("ram", "q"),
        Some(Trit::Zero)
    );

    let written = simulator.advance_phase().expect("safe rising write");
    assert_eq!(written.clock_phase, ClockPhase::HighStable);
    assert_eq!(written.output_value("ram", "q"), Some(Trit::Pos));

    simulator.set_input("data", Trit::Neg).unwrap();
    let fallen = simulator.advance_phase().expect("fall does not write");
    assert_eq!(fallen.clock_phase, ClockPhase::LowStable);
    assert_eq!(fallen.output_value("ram", "q"), Some(Trit::Pos));

    simulator.set_input("we", Trit::Zero).unwrap();
    let held = simulator.advance_phase().expect("disabled rise holds");
    assert_eq!(held.output_value("ram", "q"), Some(Trit::Pos));

    simulator.advance_phase().expect("return low");
    simulator
        .set_sources([("we", Trit::Pos), ("rst", Trit::Pos)])
        .unwrap();
    let cleared = simulator.advance_phase().expect("reset wins over write");
    assert_eq!(cleared.output_value("ram", "q"), Some(Trit::Zero));

    simulator.advance_phase().expect("return low after reset");
    simulator.set_input("rst", Trit::Zero).unwrap();
    simulator.advance_phase().expect("write after reset");
    assert_eq!(
        simulator.snapshot().output_value("ram", "q"),
        Some(Trit::Neg)
    );
    assert_eq!(simulator.reset().output_value("ram", "q"), Some(Trit::Zero));
}

#[test]
fn ram_cells_sample_all_lanes_from_the_same_pre_edge_state() {
    let mut simulator = Simulator::load(definition(
        vec![
            source("addr", Trit::Zero),
            source("seed0", Trit::Pos),
            source("seed1", Trit::Neg),
            source("select", Trit::Neg),
            source("we", Trit::Pos),
            source("rst", Trit::Zero),
            component("clock", "source.clock"),
            component("mux0", "gate.mux2"),
            component("mux1", "gate.mux2"),
            memory_cell("ram0", "internal.ram_cell", 1, vec![]),
            memory_cell("ram1", "internal.ram_cell", 1, vec![]),
        ],
        vec![
            wire("seed0", "mux0", "a"),
            connection("ram1-mux0", "ram1", "q", "mux0", "b"),
            wire("select", "mux0", "s"),
            wire("seed1", "mux1", "a"),
            connection("ram0-mux1", "ram0", "q", "mux1", "b"),
            wire("select", "mux1", "s"),
            connection("mux0-ram0", "mux0", "y", "ram0", "d"),
            connection("mux1-ram1", "mux1", "y", "ram1", "d"),
            wire("addr", "ram0", "addr0"),
            wire("addr", "ram1", "addr0"),
            wire("we", "ram0", "we"),
            wire("we", "ram1", "we"),
            wire("rst", "ram0", "rst"),
            wire("rst", "ram1", "rst"),
            wire("clock", "ram0", "clk"),
            wire("clock", "ram1", "clk"),
        ],
    ))
    .expect("valid two-lane RAM");

    let seeded = simulator.advance_phase().unwrap();
    assert_eq!(seeded.output_value("ram0", "q"), Some(Trit::Pos));
    assert_eq!(seeded.output_value("ram1", "q"), Some(Trit::Neg));

    simulator.advance_phase().unwrap();
    simulator.set_input("select", Trit::Pos).unwrap();
    let swapped = simulator.advance_phase().unwrap();
    assert_eq!(swapped.output_value("ram0", "q"), Some(Trit::Neg));
    assert_eq!(swapped.output_value("ram1", "q"), Some(Trit::Pos));
}

#[test]
fn rom_and_ram_meta_addresses_read_error_or_unknown_asynchronously() {
    let simulator = Simulator::load(definition(
        vec![
            source("neg", Trit::Neg),
            source("pos", Trit::Pos),
            component("floating-buffer", "gate.buf"),
            memory_cell("rom-x", "internal.rom_cell", 1, vec![Trit::Pos]),
            memory_cell("rom-z", "internal.rom_cell", 1, vec![Trit::Pos]),
            memory_cell("ram-e", "internal.ram_cell", 1, vec![]),
        ],
        vec![
            connection("buffer-rom-x", "floating-buffer", "y", "rom-x", "addr0"),
            wire("neg", "ram-e", "addr0"),
            wire("pos", "ram-e", "addr0"),
        ],
    ))
    .expect("valid meta-read circuit");

    let snapshot = simulator.snapshot();
    assert_eq!(snapshot.output_value("rom-x", "q"), Some(Trit::Unknown));
    assert_eq!(snapshot.output_value("rom-z", "q"), Some(Trit::Unknown));
    assert_eq!(snapshot.output_value("ram-e", "q"), Some(Trit::Error));
}

#[test]
fn unsafe_rising_write_faults_atomically_across_all_ram_cells() {
    let mut simulator = Simulator::load(definition(
        vec![
            source("addr-a", Trit::Zero),
            source("addr-b", Trit::Zero),
            source("data0", Trit::Pos),
            source("data1", Trit::Neg),
            source("we", Trit::Pos),
            source("rst", Trit::Zero),
            component("clock", "source.clock"),
            memory_cell("ram0", "internal.ram_cell", 1, vec![]),
            memory_cell("ram1", "internal.ram_cell", 1, vec![]),
        ],
        vec![
            wire("addr-a", "ram0", "addr0"),
            wire("addr-b", "ram0", "addr0"),
            wire("addr-a", "ram1", "addr0"),
            wire("addr-b", "ram1", "addr0"),
            wire("data0", "ram0", "d"),
            wire("data1", "ram1", "d"),
            wire("we", "ram0", "we"),
            wire("we", "ram1", "we"),
            wire("rst", "ram0", "rst"),
            wire("rst", "ram1", "rst"),
            wire("clock", "ram0", "clk"),
            wire("clock", "ram1", "clk"),
        ],
    ))
    .expect("valid two-cell RAM");

    simulator.advance_phase().expect("seed write");
    simulator.advance_phase().expect("return low");
    simulator
        .set_sources([
            ("addr-b", Trit::Pos),
            ("data0", Trit::Neg),
            ("data1", Trit::Pos),
        ])
        .unwrap();
    let before = simulator.snapshot();

    let fault = simulator
        .advance_phase()
        .expect_err("conflicting address must reject the whole edge");
    assert_eq!(fault.code, "UNSAFE_RAM_WRITE");
    assert_eq!(simulator.snapshot(), before);

    simulator.set_input("addr-b", Trit::Zero).unwrap();
    let restored = simulator.snapshot();
    assert_eq!(restored.output_value("ram0", "q"), Some(Trit::Pos));
    assert_eq!(restored.output_value("ram1", "q"), Some(Trit::Neg));
}

#[test]
fn flat_public_memory_macros_are_rejected_with_the_project_v3_diagnostic() {
    for type_id in ["memory.rom", "memory.ram"] {
        let circuit = definition(vec![component("memory", type_id)], vec![]);
        let validation = validate_circuit(circuit.clone()).expect_err("flat macro is invalid");
        assert_eq!(validation.len(), 1, "unexpected diagnostics for {type_id}");
        assert_eq!(
            validation[0].code,
            "STRUCTURAL_COMPONENT_REQUIRES_PROJECT_V3"
        );
        assert_eq!(validation[0].component_ids, vec!["memory"]);

        let load = Simulator::load(circuit).err().expect("flat load must fail");
        assert_eq!(load.len(), 1, "unexpected load diagnostics for {type_id}");
        assert_eq!(load[0].code, "STRUCTURAL_COMPONENT_REQUIRES_PROJECT_V3");
    }
}
