use std::collections::BTreeMap;

use crate::catalog::{ComponentKind, ComponentProperties};
use crate::trit::Trit;

pub fn evaluate(
    kind: ComponentKind,
    properties: &ComponentProperties,
    inputs: &BTreeMap<String, Trit>,
) -> BTreeMap<String, Trit> {
    match kind {
        ComponentKind::TritInput | ComponentKind::Constant => {
            BTreeMap::from([("out".to_owned(), properties.value.unwrap_or(Trit::Zero))])
        }
        ComponentKind::Probe => BTreeMap::new(),
        ComponentKind::Buf => gate_output(input(inputs, "a").normalize_gate_input()),
        ComponentKind::Neg => gate_output(neg(input(inputs, "a"))),
        ComponentKind::Min => gate_output(min_or_max(input(inputs, "a"), input(inputs, "b"), true)),
        ComponentKind::Max => {
            gate_output(min_or_max(input(inputs, "a"), input(inputs, "b"), false))
        }
        ComponentKind::IsNeg => gate_output(decode(input(inputs, "a"), Trit::Neg)),
        ComponentKind::IsZero => gate_output(decode(input(inputs, "a"), Trit::Zero)),
        ComponentKind::IsPos => gate_output(decode(input(inputs, "a"), Trit::Pos)),
        ComponentKind::Mux2 => gate_output(mux2(inputs)),
        ComponentKind::Mux3 => gate_output(mux3(inputs)),
    }
}

fn input(inputs: &BTreeMap<String, Trit>, id: &str) -> Trit {
    inputs.get(id).copied().unwrap_or(Trit::Unknown)
}

fn gate_output(value: Trit) -> BTreeMap<String, Trit> {
    BTreeMap::from([("y".to_owned(), value)])
}

fn neg(value: Trit) -> Trit {
    match value.normalize_gate_input() {
        Trit::Neg => Trit::Pos,
        Trit::Zero => Trit::Zero,
        Trit::Pos => Trit::Neg,
        Trit::Unknown | Trit::HighZ => Trit::Unknown,
        Trit::Error => Trit::Error,
    }
}

fn min_or_max(a: Trit, b: Trit, choose_min: bool) -> Trit {
    let a = a.normalize_gate_input();
    let b = b.normalize_gate_input();

    if a == Trit::Error || b == Trit::Error {
        return Trit::Error;
    }
    if a == Trit::Unknown || b == Trit::Unknown {
        return Trit::Unknown;
    }

    let a_value = a.balanced_value().expect("normalized known trit");
    let b_value = b.balanced_value().expect("normalized known trit");
    if (choose_min && a_value <= b_value) || (!choose_min && a_value >= b_value) {
        a
    } else {
        b
    }
}

fn decode(value: Trit, selected: Trit) -> Trit {
    match value.normalize_gate_input() {
        Trit::Neg | Trit::Zero | Trit::Pos if value == selected => Trit::Pos,
        Trit::Neg | Trit::Zero | Trit::Pos => Trit::Neg,
        Trit::Unknown | Trit::HighZ => Trit::Unknown,
        Trit::Error => Trit::Error,
    }
}

fn mux2(inputs: &BTreeMap<String, Trit>) -> Trit {
    match input(inputs, "s").normalize_gate_input() {
        Trit::Neg => input(inputs, "a").normalize_gate_input(),
        Trit::Pos => input(inputs, "b").normalize_gate_input(),
        Trit::Zero | Trit::Unknown | Trit::HighZ => Trit::Unknown,
        Trit::Error => Trit::Error,
    }
}

fn mux3(inputs: &BTreeMap<String, Trit>) -> Trit {
    match input(inputs, "s").normalize_gate_input() {
        Trit::Neg => input(inputs, "a").normalize_gate_input(),
        Trit::Zero => input(inputs, "b").normalize_gate_input(),
        Trit::Pos => input(inputs, "c").normalize_gate_input(),
        Trit::Unknown | Trit::HighZ => Trit::Unknown,
        Trit::Error => Trit::Error,
    }
}
