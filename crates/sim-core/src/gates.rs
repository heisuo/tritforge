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
        ComponentKind::ModSum => gate_output(mod_sum(input(inputs, "a"), input(inputs, "b"))),
        ComponentKind::Consensus => gate_output(consensus(input(inputs, "a"), input(inputs, "b"))),
        ComponentKind::Mux2 => gate_output(mux2(inputs)),
        ComponentKind::Mux3 => gate_output(mux3(inputs)),
        ComponentKind::HalfAdder => adder_outputs(inputs, &["a", "b"]),
        ComponentKind::FullAdder => adder_outputs(inputs, &["a", "b", "cin"]),
        ComponentKind::Clock
        | ComponentKind::Dff
        | ComponentKind::Register
        | ComponentKind::Rom
        | ComponentKind::Ram
        | ComponentKind::InternalRomCell
        | ComponentKind::InternalRamCell => BTreeMap::new(),
    }
}

fn input(inputs: &BTreeMap<String, Trit>, id: &str) -> Trit {
    inputs.get(id).copied().unwrap_or(Trit::Unknown)
}

fn gate_output(value: Trit) -> BTreeMap<String, Trit> {
    BTreeMap::from([("y".to_owned(), value)])
}

fn adder_outputs(inputs: &BTreeMap<String, Trit>, input_ids: &[&str]) -> BTreeMap<String, Trit> {
    let values: Vec<_> = input_ids
        .iter()
        .map(|id| input(inputs, id).normalize_gate_input())
        .collect();

    let (sum, carry) = if values.contains(&Trit::Error) {
        (Trit::Error, Trit::Error)
    } else if values.contains(&Trit::Unknown) {
        (Trit::Unknown, Trit::Unknown)
    } else {
        let total: i8 = values
            .iter()
            .map(|value| value.balanced_value().expect("known adder input"))
            .sum();
        match total {
            -3 => (Trit::Zero, Trit::Neg),
            -2 => (Trit::Pos, Trit::Neg),
            -1 => (Trit::Neg, Trit::Zero),
            0 => (Trit::Zero, Trit::Zero),
            1 => (Trit::Pos, Trit::Zero),
            2 => (Trit::Neg, Trit::Pos),
            3 => (Trit::Zero, Trit::Pos),
            _ => unreachable!("a one-trit adder total is always in -3..=3"),
        }
    };

    BTreeMap::from([("sum".to_owned(), sum), ("carry".to_owned(), carry)])
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

fn normalized_pair(a: Trit, b: Trit) -> Result<(Trit, Trit), Trit> {
    let a = a.normalize_gate_input();
    let b = b.normalize_gate_input();
    if a == Trit::Error || b == Trit::Error {
        Err(Trit::Error)
    } else if a == Trit::Unknown || b == Trit::Unknown {
        Err(Trit::Unknown)
    } else {
        Ok((a, b))
    }
}

fn mod_sum(a: Trit, b: Trit) -> Trit {
    let (a, b) = match normalized_pair(a, b) {
        Ok(pair) => pair,
        Err(meta) => return meta,
    };
    let total = a.balanced_value().expect("known trit") + b.balanced_value().expect("known trit");
    match total {
        -2 | 1 => Trit::Pos,
        -1 | 2 => Trit::Neg,
        0 => Trit::Zero,
        _ => unreachable!("two known trits sum to -2..=2"),
    }
}

fn consensus(a: Trit, b: Trit) -> Trit {
    match normalized_pair(a, b) {
        Ok((a, b)) if a == b => a,
        Ok(_) => Trit::Zero,
        Err(meta) => meta,
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
