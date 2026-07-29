use proptest::prelude::*;
use sim_core::trit::{Trit, resolve_drivers};

fn oracle_resolve_drivers(drivers: &[Trit]) -> Trit {
    if drivers.contains(&Trit::Error) {
        return Trit::Error;
    }

    let present_known: Vec<_> = [Trit::Neg, Trit::Zero, Trit::Pos]
        .into_iter()
        .filter(|value| drivers.contains(value))
        .collect();

    if present_known.len() > 1 {
        Trit::Error
    } else if drivers.contains(&Trit::Unknown) {
        Trit::Unknown
    } else {
        present_known.first().copied().unwrap_or(Trit::HighZ)
    }
}

fn trit_from_index(value: u8) -> Trit {
    match value {
        0 => Trit::Neg,
        1 => Trit::Zero,
        2 => Trit::Pos,
        3 => Trit::Unknown,
        4 => Trit::HighZ,
        _ => Trit::Error,
    }
}

#[test]
fn trit_serializes_as_stable_symbols_and_round_trips() {
    let values = [
        (Trit::Neg, "\"T\""),
        (Trit::Zero, "\"0\""),
        (Trit::Pos, "\"1\""),
        (Trit::Unknown, "\"X\""),
        (Trit::HighZ, "\"Z\""),
        (Trit::Error, "\"E\""),
    ];

    for (value, encoded) in values {
        assert_eq!(serde_json::to_string(&value).unwrap(), encoded);
        assert_eq!(serde_json::from_str::<Trit>(encoded).unwrap(), value);
    }
}

#[test]
fn helpers_distinguish_known_values_from_meta_states() {
    let values = [
        (Trit::Neg, true, Some(-1)),
        (Trit::Zero, true, Some(0)),
        (Trit::Pos, true, Some(1)),
        (Trit::Unknown, false, None),
        (Trit::HighZ, false, None),
        (Trit::Error, false, None),
    ];

    for (value, is_known, balanced_value) in values {
        assert_eq!(value.is_known(), is_known);
        assert_eq!(value.balanced_value(), balanced_value);
    }
}

#[test]
fn gate_input_normalization_only_converts_high_z_to_unknown() {
    let values = [
        (Trit::Neg, Trit::Neg),
        (Trit::Zero, Trit::Zero),
        (Trit::Pos, Trit::Pos),
        (Trit::Unknown, Trit::Unknown),
        (Trit::HighZ, Trit::Unknown),
        (Trit::Error, Trit::Error),
    ];

    for (value, normalized) in values {
        assert_eq!(value.normalize_gate_input(), normalized);
    }
}

#[test]
fn resolves_known_unknown_high_z_and_conflict() {
    assert_eq!(resolve_drivers(&[]), Trit::HighZ);
    assert_eq!(resolve_drivers(&[Trit::HighZ, Trit::Neg]), Trit::Neg);
    assert_eq!(resolve_drivers(&[Trit::Pos, Trit::Pos]), Trit::Pos);
    assert_eq!(resolve_drivers(&[Trit::Neg, Trit::Pos]), Trit::Error);
    assert_eq!(resolve_drivers(&[Trit::Zero, Trit::Unknown]), Trit::Unknown);
    assert_eq!(resolve_drivers(&[Trit::Error, Trit::HighZ]), Trit::Error);
}

#[test]
fn known_conflict_takes_precedence_over_an_unknown_middle_driver() {
    let mut drivers = [Trit::Neg, Trit::Unknown, Trit::Zero];

    assert_eq!(resolve_drivers(&drivers), Trit::Error);

    drivers.rotate_left(1);
    assert_eq!(resolve_drivers(&drivers), Trit::Error);
}

#[test]
fn resolves_the_complete_two_driver_matrix() {
    let values = [
        Trit::Neg,
        Trit::Zero,
        Trit::Pos,
        Trit::Unknown,
        Trit::HighZ,
        Trit::Error,
    ];
    let expected = [
        [
            Trit::Neg,
            Trit::Error,
            Trit::Error,
            Trit::Unknown,
            Trit::Neg,
            Trit::Error,
        ],
        [
            Trit::Error,
            Trit::Zero,
            Trit::Error,
            Trit::Unknown,
            Trit::Zero,
            Trit::Error,
        ],
        [
            Trit::Error,
            Trit::Error,
            Trit::Pos,
            Trit::Unknown,
            Trit::Pos,
            Trit::Error,
        ],
        [
            Trit::Unknown,
            Trit::Unknown,
            Trit::Unknown,
            Trit::Unknown,
            Trit::Unknown,
            Trit::Error,
        ],
        [
            Trit::Neg,
            Trit::Zero,
            Trit::Pos,
            Trit::Unknown,
            Trit::HighZ,
            Trit::Error,
        ],
        [
            Trit::Error,
            Trit::Error,
            Trit::Error,
            Trit::Error,
            Trit::Error,
            Trit::Error,
        ],
    ];

    for (row, left) in values.iter().copied().enumerate() {
        for (column, right) in values.iter().copied().enumerate() {
            assert_eq!(
                resolve_drivers(&[left, right]),
                expected[row][column],
                "unexpected resolution for {left:?} and {right:?}"
            );
        }
    }
}

proptest! {
    #[test]
    fn resolution_matches_the_oracle_and_is_permutation_invariant(
        values in prop::collection::vec(0u8..6, 0..=12)
    ) {
        let original: Vec<_> = values.into_iter().map(trit_from_index).collect();
        let expected = oracle_resolve_drivers(&original);

        prop_assert_eq!(resolve_drivers(&original), expected);

        let mut reversed = original.clone();
        reversed.reverse();
        prop_assert_eq!(resolve_drivers(&original), resolve_drivers(&reversed));

        if !original.is_empty() {
            let mut rotated = original.clone();
            rotated.rotate_left(1);
            prop_assert_eq!(resolve_drivers(&rotated), expected);
        }
    }
}
