use std::collections::BTreeMap;

use sim_core::catalog::{
    ComponentKind, ComponentProperties, PortDirection, TruthTableRow, component_catalog,
};
use sim_core::gates::evaluate;
use sim_core::trit::Trit;

const KNOWN: [Trit; 3] = [Trit::Neg, Trit::Zero, Trit::Pos];

fn expected_inputs(arity: usize) -> Vec<Vec<Trit>> {
    fn extend(rows: &mut Vec<Vec<Trit>>, prefix: &mut Vec<Trit>, remaining: usize) {
        if remaining == 0 {
            rows.push(prefix.clone());
            return;
        }

        for value in KNOWN {
            prefix.push(value);
            extend(rows, prefix, remaining - 1);
            prefix.pop();
        }
    }

    let mut rows = Vec::new();
    extend(&mut rows, &mut Vec::new(), arity);
    rows
}

#[test]
fn phase_one_catalog_has_exact_stable_ids_and_type_lookup() {
    let catalog = component_catalog();
    let ids: Vec<_> = catalog
        .iter()
        .map(|descriptor| descriptor.type_id.as_str())
        .collect();

    assert_eq!(
        ids,
        [
            "source.trit_input",
            "source.constant",
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
            "module.half_adder",
            "module.full_adder",
            "source.clock",
            "sequential.dff",
            "sequential.register",
        ]
    );

    for descriptor in catalog {
        assert_eq!(
            descriptor.kind.type_id(),
            descriptor.type_id,
            "kind and descriptor ID diverged"
        );
        assert_eq!(
            ComponentKind::from_type_id(&descriptor.type_id),
            Some(descriptor.kind)
        );
        assert!(!descriptor.display_name.is_empty());
    }
    assert_eq!(ComponentKind::from_type_id("gate.missing"), None);
}

#[test]
fn catalog_has_exact_categories_ports_and_truth_table_sizes() {
    let expected = [
        ("source", vec![("out", PortDirection::Output)], 0_usize),
        ("source", vec![("out", PortDirection::Output)], 0_usize),
        ("sink", vec![("in", PortDirection::Input)], 0_usize),
        (
            "gate",
            vec![("a", PortDirection::Input), ("y", PortDirection::Output)],
            3_usize,
        ),
        (
            "gate",
            vec![("a", PortDirection::Input), ("y", PortDirection::Output)],
            3_usize,
        ),
        (
            "gate",
            vec![
                ("a", PortDirection::Input),
                ("b", PortDirection::Input),
                ("y", PortDirection::Output),
            ],
            9_usize,
        ),
        (
            "gate",
            vec![
                ("a", PortDirection::Input),
                ("b", PortDirection::Input),
                ("y", PortDirection::Output),
            ],
            9_usize,
        ),
        (
            "gate",
            vec![("a", PortDirection::Input), ("y", PortDirection::Output)],
            3_usize,
        ),
        (
            "gate",
            vec![("a", PortDirection::Input), ("y", PortDirection::Output)],
            3_usize,
        ),
        (
            "gate",
            vec![("a", PortDirection::Input), ("y", PortDirection::Output)],
            3_usize,
        ),
        (
            "gate",
            vec![
                ("a", PortDirection::Input),
                ("b", PortDirection::Input),
                ("y", PortDirection::Output),
            ],
            9_usize,
        ),
        (
            "gate",
            vec![
                ("a", PortDirection::Input),
                ("b", PortDirection::Input),
                ("y", PortDirection::Output),
            ],
            9_usize,
        ),
        (
            "gate",
            vec![
                ("a", PortDirection::Input),
                ("b", PortDirection::Input),
                ("s", PortDirection::Input),
                ("y", PortDirection::Output),
            ],
            27_usize,
        ),
        (
            "gate",
            vec![
                ("a", PortDirection::Input),
                ("b", PortDirection::Input),
                ("c", PortDirection::Input),
                ("s", PortDirection::Input),
                ("y", PortDirection::Output),
            ],
            81_usize,
        ),
        (
            "module",
            vec![
                ("a", PortDirection::Input),
                ("b", PortDirection::Input),
                ("sum", PortDirection::Output),
                ("carry", PortDirection::Output),
            ],
            9_usize,
        ),
        (
            "module",
            vec![
                ("a", PortDirection::Input),
                ("b", PortDirection::Input),
                ("cin", PortDirection::Input),
                ("sum", PortDirection::Output),
                ("carry", PortDirection::Output),
            ],
            27_usize,
        ),
        ("source", vec![("out", PortDirection::Output)], 0_usize),
        (
            "sequential",
            vec![
                ("d", PortDirection::Input),
                ("clk", PortDirection::Input),
                ("en", PortDirection::Input),
                ("rst", PortDirection::Input),
                ("q", PortDirection::Output),
            ],
            0_usize,
        ),
        (
            "sequential",
            vec![
                ("d", PortDirection::Input),
                ("clk", PortDirection::Input),
                ("en", PortDirection::Input),
                ("rst", PortDirection::Input),
                ("q", PortDirection::Output),
            ],
            0_usize,
        ),
    ];

    let catalog = component_catalog();
    assert_eq!(catalog.len(), expected.len());

    for (descriptor, (category, ports, truth_table_size)) in catalog.iter().zip(expected.iter()) {
        assert_eq!(&descriptor.category, category);
        assert_eq!(
            descriptor
                .ports
                .iter()
                .map(|port| (port.id.as_str(), port.direction))
                .collect::<Vec<_>>(),
            *ports,
            "unexpected ports for {}",
            descriptor.type_id
        );
        assert_eq!(
            descriptor.kind.port_descriptors(),
            descriptor.ports,
            "kind and descriptor ports diverged for {}",
            descriptor.type_id
        );
        assert_eq!(
            descriptor.truth_table.len(),
            *truth_table_size,
            "unexpected truth-table size for {}",
            descriptor.type_id
        );
    }
}

#[test]
fn project_v3_foundation_bumps_the_core_api_version() {
    assert_eq!(sim_core::api_version(), 3);
}

#[test]
fn port_directions_serialize_as_snake_case() {
    assert_eq!(
        serde_json::to_string(&PortDirection::Input).unwrap(),
        r#""input""#
    );
    assert_eq!(
        serde_json::to_string(&PortDirection::Output).unwrap(),
        r#""output""#
    );
    assert_eq!(
        serde_json::from_str::<PortDirection>(r#""input""#).unwrap(),
        PortDirection::Input
    );
    assert_eq!(
        serde_json::from_str::<PortDirection>(r#""output""#).unwrap(),
        PortDirection::Output
    );
}

#[test]
fn truth_tables_use_port_order_and_public_evaluator_results() {
    for descriptor in component_catalog()
        .into_iter()
        .filter(|descriptor| !descriptor.truth_table.is_empty())
    {
        let input_ports: Vec<_> = descriptor
            .ports
            .iter()
            .filter(|port| port.direction == PortDirection::Input)
            .map(|port| port.id.as_str())
            .collect();
        let output_ports: Vec<_> = descriptor
            .ports
            .iter()
            .filter(|port| port.direction == PortDirection::Output)
            .map(|port| port.id.as_str())
            .collect();

        assert_eq!(
            descriptor
                .truth_table
                .iter()
                .map(|row| row.inputs.clone())
                .collect::<Vec<_>>(),
            expected_inputs(input_ports.len()),
            "row input order is unstable for {}",
            descriptor.type_id
        );

        for TruthTableRow { inputs, outputs } in descriptor.truth_table {
            let input_map: BTreeMap<_, _> = input_ports
                .iter()
                .zip(inputs.iter().copied())
                .map(|(id, value)| ((*id).to_owned(), value))
                .collect();
            let evaluated = evaluate(descriptor.kind, &ComponentProperties::default(), &input_map);
            let expected_outputs: Vec<_> = output_ports
                .iter()
                .map(|id| evaluated.get(*id).copied().expect("declared output"))
                .collect();

            assert_eq!(
                outputs, expected_outputs,
                "truth-table output disagrees for {} and {inputs:?}",
                descriptor.type_id
            );
        }
    }
}
