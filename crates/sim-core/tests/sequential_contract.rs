use sim_core::sequential::dff_next;
use sim_core::trit::Trit;

const TRITS: [Trit; 6] = [
    Trit::Neg,
    Trit::Zero,
    Trit::Pos,
    Trit::Unknown,
    Trit::HighZ,
    Trit::Error,
];

#[test]
fn asserted_reset_wins_for_every_current_data_and_enable_state() {
    for current in TRITS {
        for d in TRITS {
            for en in TRITS {
                assert_eq!(
                    dff_next(current, d, en, Trit::Pos),
                    Trit::Zero,
                    "asserted reset did not win for current={current:?}, d={d:?}, en={en:?}"
                );
            }
        }
    }
}

#[test]
fn reset_meta_states_override_every_current_data_and_enable_state() {
    for (rst, expected) in [
        (Trit::Error, Trit::Error),
        (Trit::Unknown, Trit::Unknown),
        (Trit::HighZ, Trit::Unknown),
    ] {
        for current in TRITS {
            for d in TRITS {
                for en in TRITS {
                    assert_eq!(
                        dff_next(current, d, en, rst),
                        expected,
                        "unexpected reset result for current={current:?}, d={d:?}, en={en:?}, rst={rst:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn positive_enable_captures_each_data_state_when_reset_is_deasserted() {
    for rst in [Trit::Neg, Trit::Zero] {
        for current in TRITS {
            for (d, expected) in [
                (Trit::Neg, Trit::Neg),
                (Trit::Zero, Trit::Zero),
                (Trit::Pos, Trit::Pos),
                (Trit::Unknown, Trit::Unknown),
                (Trit::HighZ, Trit::Unknown),
                (Trit::Error, Trit::Error),
            ] {
                assert_eq!(
                    dff_next(current, d, Trit::Pos, rst),
                    expected,
                    "unexpected capture for current={current:?}, d={d:?}, rst={rst:?}"
                );
            }
        }
    }
}

#[test]
fn negative_and_zero_enable_hold_each_current_state() {
    for rst in [Trit::Neg, Trit::Zero] {
        for en in [Trit::Neg, Trit::Zero] {
            for current in TRITS {
                for d in TRITS {
                    assert_eq!(
                        dff_next(current, d, en, rst),
                        current,
                        "state was not held for current={current:?}, d={d:?}, en={en:?}, rst={rst:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn enable_meta_states_have_frozen_results_when_reset_is_deasserted() {
    for rst in [Trit::Neg, Trit::Zero] {
        for (en, expected) in [
            (Trit::Error, Trit::Error),
            (Trit::Unknown, Trit::Unknown),
            (Trit::HighZ, Trit::Unknown),
        ] {
            for current in TRITS {
                for d in TRITS {
                    assert_eq!(
                        dff_next(current, d, en, rst),
                        expected,
                        "unexpected enable result for current={current:?}, d={d:?}, en={en:?}, rst={rst:?}"
                    );
                }
            }
        }
    }
}
