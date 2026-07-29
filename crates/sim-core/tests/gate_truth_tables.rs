use std::collections::BTreeMap;

use proptest::prelude::*;
use sim_core::catalog::{ComponentKind, ComponentProperties};
use sim_core::gates::evaluate;
use sim_core::trit::Trit;

const KNOWN: [Trit; 3] = [Trit::Neg, Trit::Zero, Trit::Pos];

fn inputs(values: &[(&str, Trit)]) -> BTreeMap<String, Trit> {
    values
        .iter()
        .map(|(name, value)| ((*name).into(), *value))
        .collect()
}

fn output(kind: ComponentKind, values: &[(&str, Trit)]) -> Trit {
    evaluate(kind, &ComponentProperties::default(), &inputs(values))["y"]
}

fn known(index: u8) -> Trit {
    KNOWN[index as usize]
}

fn unary(kind: ComponentKind, a: Trit) -> Trit {
    output(kind, &[("a", a)])
}

fn binary(kind: ComponentKind, a: Trit, b: Trit) -> Trit {
    output(kind, &[("a", a), ("b", b)])
}

#[test]
fn neg_min_max_and_decoders_are_exhaustive_for_known_inputs() {
    let neg_expected = [Trit::Pos, Trit::Zero, Trit::Neg];
    let min_expected = [
        Trit::Neg,
        Trit::Neg,
        Trit::Neg,
        Trit::Neg,
        Trit::Zero,
        Trit::Zero,
        Trit::Neg,
        Trit::Zero,
        Trit::Pos,
    ];
    let max_expected = [
        Trit::Neg,
        Trit::Zero,
        Trit::Pos,
        Trit::Zero,
        Trit::Zero,
        Trit::Pos,
        Trit::Pos,
        Trit::Pos,
        Trit::Pos,
    ];

    for (a_index, a) in KNOWN.into_iter().enumerate() {
        assert_eq!(unary(ComponentKind::Buf, a), a);
        assert_eq!(unary(ComponentKind::Neg, a), neg_expected[a_index]);

        for (b_index, b) in KNOWN.into_iter().enumerate() {
            let flat = a_index * KNOWN.len() + b_index;
            assert_eq!(binary(ComponentKind::Min, a, b), min_expected[flat]);
            assert_eq!(binary(ComponentKind::Max, a, b), max_expected[flat]);
        }

        for (kind, selected) in [
            (ComponentKind::IsNeg, a == Trit::Neg),
            (ComponentKind::IsZero, a == Trit::Zero),
            (ComponentKind::IsPos, a == Trit::Pos),
        ] {
            assert_eq!(unary(kind, a), if selected { Trit::Pos } else { Trit::Neg });
        }
    }
}

#[test]
fn muxes_are_exhaustive_for_known_inputs() {
    for a in KNOWN {
        for b in KNOWN {
            for selector in KNOWN {
                let expected = match selector {
                    Trit::Neg => a,
                    Trit::Zero => Trit::Unknown,
                    Trit::Pos => b,
                    _ => unreachable!(),
                };
                assert_eq!(
                    output(ComponentKind::Mux2, &[("a", a), ("b", b), ("s", selector)]),
                    expected
                );
            }
        }
    }

    for a in KNOWN {
        for b in KNOWN {
            for c in KNOWN {
                for selector in KNOWN {
                    let expected = match selector {
                        Trit::Neg => a,
                        Trit::Zero => b,
                        Trit::Pos => c,
                        _ => unreachable!(),
                    };
                    assert_eq!(
                        output(
                            ComponentKind::Mux3,
                            &[("a", a), ("b", b), ("c", c), ("s", selector)]
                        ),
                        expected
                    );
                }
            }
        }
    }
}

#[test]
fn muxes_ignore_errors_on_unselected_data_inputs() {
    assert_eq!(
        output(
            ComponentKind::Mux2,
            &[("a", Trit::Neg), ("b", Trit::Error), ("s", Trit::Neg)]
        ),
        Trit::Neg
    );
    assert_eq!(
        output(
            ComponentKind::Mux2,
            &[("a", Trit::Error), ("b", Trit::Pos), ("s", Trit::Pos)]
        ),
        Trit::Pos
    );

    for (selector, expected) in [
        (Trit::Neg, Trit::Neg),
        (Trit::Zero, Trit::Zero),
        (Trit::Pos, Trit::Pos),
    ] {
        let (a, b, c) = match selector {
            Trit::Neg => (expected, Trit::Error, Trit::Error),
            Trit::Zero => (Trit::Error, expected, Trit::Error),
            Trit::Pos => (Trit::Error, Trit::Error, expected),
            _ => unreachable!(),
        };
        assert_eq!(
            output(
                ComponentKind::Mux3,
                &[("a", a), ("b", b), ("c", c), ("s", selector)]
            ),
            expected
        );
    }
}

#[test]
fn ordinary_gates_propagate_meta_states_conservatively() {
    assert_eq!(unary(ComponentKind::Buf, Trit::HighZ), Trit::Unknown);
    assert_eq!(unary(ComponentKind::Buf, Trit::Unknown), Trit::Unknown);
    assert_eq!(unary(ComponentKind::Buf, Trit::Error), Trit::Error);

    assert_eq!(unary(ComponentKind::Neg, Trit::HighZ), Trit::Unknown);
    assert_eq!(unary(ComponentKind::Neg, Trit::Unknown), Trit::Unknown);
    assert_eq!(unary(ComponentKind::Neg, Trit::Error), Trit::Error);

    for kind in [ComponentKind::Min, ComponentKind::Max] {
        assert_eq!(binary(kind, Trit::Neg, Trit::HighZ), Trit::Unknown);
        assert_eq!(binary(kind, Trit::Unknown, Trit::Pos), Trit::Unknown);
        assert_eq!(binary(kind, Trit::Error, Trit::Pos), Trit::Error);
        assert_eq!(binary(kind, Trit::Unknown, Trit::Error), Trit::Error);
    }

    for kind in [
        ComponentKind::IsNeg,
        ComponentKind::IsZero,
        ComponentKind::IsPos,
    ] {
        assert_eq!(unary(kind, Trit::HighZ), Trit::Unknown);
        assert_eq!(unary(kind, Trit::Unknown), Trit::Unknown);
        assert_eq!(unary(kind, Trit::Error), Trit::Error);
    }
}

#[test]
fn mux_selectors_and_selected_data_handle_meta_states_conservatively() {
    for kind_and_inputs in [
        (
            ComponentKind::Mux2,
            vec![("a", Trit::Neg), ("b", Trit::Pos)],
        ),
        (
            ComponentKind::Mux3,
            vec![("a", Trit::Neg), ("b", Trit::Zero), ("c", Trit::Pos)],
        ),
    ] {
        let (kind, mut values) = kind_and_inputs;
        values.push(("s", Trit::HighZ));
        assert_eq!(output(kind, &values), Trit::Unknown);
        *values.last_mut().unwrap() = ("s", Trit::Unknown);
        assert_eq!(output(kind, &values), Trit::Unknown);
        *values.last_mut().unwrap() = ("s", Trit::Error);
        assert_eq!(output(kind, &values), Trit::Error);
    }

    assert_eq!(
        output(
            ComponentKind::Mux2,
            &[("a", Trit::HighZ), ("b", Trit::Pos), ("s", Trit::Neg)]
        ),
        Trit::Unknown
    );
    assert_eq!(
        output(
            ComponentKind::Mux2,
            &[("a", Trit::Neg), ("b", Trit::Error), ("s", Trit::Zero)]
        ),
        Trit::Unknown
    );
    assert_eq!(
        output(
            ComponentKind::Mux3,
            &[
                ("a", Trit::Neg),
                ("b", Trit::HighZ),
                ("c", Trit::Pos),
                ("s", Trit::Zero),
            ]
        ),
        Trit::Unknown
    );
}

#[test]
fn sources_use_default_or_configured_values_and_probe_has_no_outputs() {
    for kind in [ComponentKind::TritInput, ComponentKind::Constant] {
        assert_eq!(
            evaluate(kind, &ComponentProperties::default(), &BTreeMap::new()).get("out"),
            Some(&Trit::Zero)
        );

        for value in [
            Trit::Neg,
            Trit::Zero,
            Trit::Pos,
            Trit::Unknown,
            Trit::HighZ,
            Trit::Error,
        ] {
            let properties = ComponentProperties { value: Some(value) };
            assert_eq!(
                evaluate(kind, &properties, &BTreeMap::new()).get("out"),
                Some(&value)
            );
        }
    }

    assert!(
        evaluate(
            ComponentKind::Probe,
            &ComponentProperties::default(),
            &inputs(&[("in", Trit::Pos)])
        )
        .is_empty()
    );
}

proptest! {
    #[test]
    fn known_gate_algebra(a in 0_u8..3, b in 0_u8..3) {
        let a = known(a);
        let b = known(b);

        prop_assert_eq!(
            unary(ComponentKind::Neg, unary(ComponentKind::Neg, a)),
            a
        );
        prop_assert_eq!(
            binary(ComponentKind::Min, a, b),
            binary(ComponentKind::Min, b, a)
        );
        prop_assert_eq!(
            binary(ComponentKind::Max, a, b),
            binary(ComponentKind::Max, b, a)
        );

        let lhs = binary(ComponentKind::Min, a, b);
        let rhs = unary(
            ComponentKind::Neg,
            binary(
                ComponentKind::Max,
                unary(ComponentKind::Neg, a),
                unary(ComponentKind::Neg, b),
            ),
        );
        prop_assert_eq!(lhs, rhs);
    }
}
