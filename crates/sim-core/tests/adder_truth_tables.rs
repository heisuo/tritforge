use sim_core::catalog::{ComponentKind, ComponentProperties};
use sim_core::gates::evaluate;
use sim_core::trit::Trit;

const KNOWN: [Trit; 3] = [Trit::Neg, Trit::Zero, Trit::Pos];

fn evaluate_adder(kind: ComponentKind, inputs: &[(&str, Trit)]) -> (Trit, Trit) {
    let inputs = inputs
        .iter()
        .map(|(id, value)| ((*id).to_owned(), *value))
        .collect();
    let outputs = evaluate(kind, &ComponentProperties::default(), &inputs);

    (outputs["sum"], outputs["carry"])
}

fn balanced_value(value: Trit) -> i8 {
    value.balanced_value().expect("known adder output")
}

#[test]
fn half_adder_exhaustively_preserves_balanced_ternary_value() {
    for a in KNOWN {
        for b in KNOWN {
            let (sum, carry) = evaluate_adder(ComponentKind::HalfAdder, &[("a", a), ("b", b)]);

            assert_eq!(
                balanced_value(a) + balanced_value(b),
                balanced_value(sum) + 3 * balanced_value(carry),
                "half adder failed for a={a:?}, b={b:?}"
            );
        }
    }
}

#[test]
fn full_adder_exhaustively_preserves_balanced_ternary_value() {
    for a in KNOWN {
        for b in KNOWN {
            for cin in KNOWN {
                let (sum, carry) = evaluate_adder(
                    ComponentKind::FullAdder,
                    &[("a", a), ("b", b), ("cin", cin)],
                );

                assert_eq!(
                    balanced_value(a) + balanced_value(b) + balanced_value(cin),
                    balanced_value(sum) + 3 * balanced_value(carry),
                    "full adder failed for a={a:?}, b={b:?}, cin={cin:?}"
                );
            }
        }
    }
}

#[test]
fn adders_propagate_meta_values_conservatively_to_both_outputs() {
    let cases = [
        (Trit::HighZ, Trit::Unknown),
        (Trit::Unknown, Trit::Unknown),
        (Trit::Error, Trit::Error),
    ];

    for (input, expected) in cases {
        assert_eq!(
            evaluate_adder(
                ComponentKind::FullAdder,
                &[("a", Trit::Pos), ("b", Trit::Zero), ("cin", input)],
            ),
            (expected, expected)
        );
    }
}
