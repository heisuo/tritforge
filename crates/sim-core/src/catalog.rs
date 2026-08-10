use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::gates::evaluate;
use crate::trit::Trit;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortDirection {
    Input,
    Output,
    InOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortDescriptor {
    pub id: String,
    pub direction: PortDirection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComponentKind {
    TritInput,
    Constant,
    Probe,
    Buf,
    Neg,
    Min,
    Max,
    IsNeg,
    IsZero,
    IsPos,
    ModSum,
    Consensus,
    Mux2,
    Mux3,
    HalfAdder,
    FullAdder,
    Clock,
    Dff,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentProperties {
    pub value: Option<Trit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentDescriptor {
    pub type_id: String,
    pub display_name: String,
    pub category: String,
    pub kind: ComponentKind,
    pub ports: Vec<PortDescriptor>,
    pub truth_table: Vec<TruthTableRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TruthTableRow {
    pub inputs: Vec<Trit>,
    pub outputs: Vec<Trit>,
}

impl ComponentKind {
    pub const fn type_id(self) -> &'static str {
        match self {
            Self::TritInput => "source.trit_input",
            Self::Constant => "source.constant",
            Self::Probe => "sink.probe",
            Self::Buf => "gate.buf",
            Self::Neg => "gate.neg",
            Self::Min => "gate.min",
            Self::Max => "gate.max",
            Self::IsNeg => "gate.is_neg",
            Self::IsZero => "gate.is_zero",
            Self::IsPos => "gate.is_pos",
            Self::ModSum => "gate.mod_sum",
            Self::Consensus => "gate.consensus",
            Self::Mux2 => "gate.mux2",
            Self::Mux3 => "gate.mux3",
            Self::HalfAdder => "module.half_adder",
            Self::FullAdder => "module.full_adder",
            Self::Clock => "source.clock",
            Self::Dff => "sequential.dff",
        }
    }

    pub fn from_type_id(type_id: &str) -> Option<Self> {
        match type_id {
            "source.trit_input" => Some(Self::TritInput),
            "source.constant" => Some(Self::Constant),
            "sink.probe" => Some(Self::Probe),
            "gate.buf" => Some(Self::Buf),
            "gate.neg" => Some(Self::Neg),
            "gate.min" => Some(Self::Min),
            "gate.max" => Some(Self::Max),
            "gate.is_neg" => Some(Self::IsNeg),
            "gate.is_zero" => Some(Self::IsZero),
            "gate.is_pos" => Some(Self::IsPos),
            "gate.mod_sum" => Some(Self::ModSum),
            "gate.consensus" => Some(Self::Consensus),
            "gate.mux2" => Some(Self::Mux2),
            "gate.mux3" => Some(Self::Mux3),
            "module.half_adder" => Some(Self::HalfAdder),
            "module.full_adder" => Some(Self::FullAdder),
            "source.clock" => Some(Self::Clock),
            "sequential.dff" => Some(Self::Dff),
            _ => None,
        }
    }

    pub fn port_descriptors(self) -> Vec<PortDescriptor> {
        match self {
            Self::TritInput | Self::Constant | Self::Clock => {
                vec![port("out", PortDirection::Output)]
            }
            Self::Probe => vec![port("in", PortDirection::Input)],
            Self::Buf | Self::Neg | Self::IsNeg | Self::IsZero | Self::IsPos => vec![
                port("a", PortDirection::Input),
                port("y", PortDirection::Output),
            ],
            Self::Min | Self::Max | Self::ModSum | Self::Consensus => vec![
                port("a", PortDirection::Input),
                port("b", PortDirection::Input),
                port("y", PortDirection::Output),
            ],
            Self::Mux2 => vec![
                port("a", PortDirection::Input),
                port("b", PortDirection::Input),
                port("s", PortDirection::Input),
                port("y", PortDirection::Output),
            ],
            Self::Mux3 => vec![
                port("a", PortDirection::Input),
                port("b", PortDirection::Input),
                port("c", PortDirection::Input),
                port("s", PortDirection::Input),
                port("y", PortDirection::Output),
            ],
            Self::HalfAdder => vec![
                port("a", PortDirection::Input),
                port("b", PortDirection::Input),
                port("sum", PortDirection::Output),
                port("carry", PortDirection::Output),
            ],
            Self::FullAdder => vec![
                port("a", PortDirection::Input),
                port("b", PortDirection::Input),
                port("cin", PortDirection::Input),
                port("sum", PortDirection::Output),
                port("carry", PortDirection::Output),
            ],
            Self::Dff => vec![
                port("d", PortDirection::Input),
                port("clk", PortDirection::Input),
                port("en", PortDirection::Input),
                port("rst", PortDirection::Input),
                port("q", PortDirection::Output),
            ],
        }
    }
}

pub fn component_catalog() -> Vec<ComponentDescriptor> {
    [
        (ComponentKind::TritInput, "Trit Input", "source"),
        (ComponentKind::Constant, "Constant", "source"),
        (ComponentKind::Probe, "Probe", "sink"),
        (ComponentKind::Buf, "Buffer", "gate"),
        (ComponentKind::Neg, "Negate", "gate"),
        (ComponentKind::Min, "Minimum", "gate"),
        (ComponentKind::Max, "Maximum", "gate"),
        (ComponentKind::IsNeg, "Is Negative", "gate"),
        (ComponentKind::IsZero, "Is Zero", "gate"),
        (ComponentKind::IsPos, "Is Positive", "gate"),
        (ComponentKind::ModSum, "Modulo-3 Sum", "gate"),
        (ComponentKind::Consensus, "Consensus", "gate"),
        (ComponentKind::Mux2, "2-Way Multiplexer", "gate"),
        (ComponentKind::Mux3, "3-Way Multiplexer", "gate"),
        (ComponentKind::HalfAdder, "Half Adder", "module"),
        (ComponentKind::FullAdder, "Full Adder", "module"),
        (ComponentKind::Clock, "Clock", "source"),
        (ComponentKind::Dff, "D Flip-Flop", "sequential"),
    ]
    .into_iter()
    .map(|(kind, display_name, category)| descriptor(kind, display_name, category))
    .collect()
}

fn port(id: &str, direction: PortDirection) -> PortDescriptor {
    PortDescriptor {
        id: id.to_owned(),
        direction,
    }
}

fn descriptor(kind: ComponentKind, display_name: &str, category: &str) -> ComponentDescriptor {
    let ports = kind.port_descriptors();
    let truth_table = if matches!(category, "gate" | "module") {
        build_truth_table(kind, &ports)
    } else {
        Vec::new()
    };

    ComponentDescriptor {
        type_id: kind.type_id().to_owned(),
        display_name: display_name.to_owned(),
        category: category.to_owned(),
        kind,
        ports,
        truth_table,
    }
}

fn build_truth_table(kind: ComponentKind, ports: &[PortDescriptor]) -> Vec<TruthTableRow> {
    let input_ids: Vec<_> = ports
        .iter()
        .filter(|port| port.direction == PortDirection::Input)
        .map(|port| port.id.as_str())
        .collect();
    let output_ids: Vec<_> = ports
        .iter()
        .filter(|port| port.direction == PortDirection::Output)
        .map(|port| port.id.as_str())
        .collect();

    known_input_rows(input_ids.len())
        .into_iter()
        .map(|inputs| {
            let input_map: BTreeMap<_, _> = input_ids
                .iter()
                .zip(inputs.iter().copied())
                .map(|(id, value)| ((*id).to_owned(), value))
                .collect();
            let evaluated = evaluate(kind, &ComponentProperties::default(), &input_map);
            let outputs = output_ids
                .iter()
                .map(|id| evaluated.get(*id).copied().expect("declared gate output"))
                .collect();

            TruthTableRow { inputs, outputs }
        })
        .collect()
}

fn known_input_rows(arity: usize) -> Vec<Vec<Trit>> {
    fn extend(rows: &mut Vec<Vec<Trit>>, prefix: &mut Vec<Trit>, remaining: usize) {
        if remaining == 0 {
            rows.push(prefix.clone());
            return;
        }

        for value in [Trit::Neg, Trit::Zero, Trit::Pos] {
            prefix.push(value);
            extend(rows, prefix, remaining - 1);
            prefix.pop();
        }
    }

    let mut rows = Vec::new();
    extend(&mut rows, &mut Vec::with_capacity(arity), arity);
    rows
}
