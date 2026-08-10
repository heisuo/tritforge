use sim_core::signal::{KnownWord, SignalShape, WordValue};
use sim_core::trit::Trit;

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
