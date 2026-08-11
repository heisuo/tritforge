use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::project::{
    ProjectComponent, ProjectProperties, QualifiedComponentRef, QualifiedPortRef,
};
use crate::signal::{KnownWord, SignalShape};
use crate::trit::Trit;

pub const REGISTER_TYPE_ID: &str = "sequential.register";
pub const ROM_TYPE_ID: &str = "memory.rom";
pub const RAM_TYPE_ID: &str = "memory.ram";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralPrimitiveInspection {
    /// Identifier of the primitive in the executable flat circuit.
    pub component_id: String,
    pub type_id: String,
    /// Primitive port ID to the user-authored macro port that produced it.
    pub port_origins: BTreeMap<String, QualifiedPortRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralExpansionInspection {
    pub source: QualifiedComponentRef,
    pub primitives: Vec<StructuralPrimitiveInspection>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegisterLane {
    pub component: ProjectComponent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegisterExpansion {
    pub lanes: Vec<RegisterLane>,
    pub port_bits: BTreeMap<String, Vec<Vec<(String, String)>>>,
    pub port_origins: BTreeMap<QualifiedPortRef, QualifiedPortRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MemoryLane {
    pub component: ProjectComponent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MemoryExpansion {
    pub lanes: Vec<MemoryLane>,
    pub port_bits: BTreeMap<String, Vec<Vec<(String, String)>>>,
    pub port_origins: BTreeMap<QualifiedPortRef, QualifiedPortRef>,
}

pub(crate) fn register_width(component: &ProjectComponent) -> Option<u8> {
    if component.type_id != REGISTER_TYPE_ID {
        return None;
    }
    component
        .properties
        .get("width")
        .and_then(serde_json::Value::as_u64)
        .and_then(|width| u8::try_from(width).ok())
}

pub(crate) fn expanded_component_count(component: &ProjectComponent) -> usize {
    register_width(component)
        .or_else(|| memory_word_width(component))
        .map_or(1, usize::from)
}

pub(crate) fn endpoint_multiplicity(component: &ProjectComponent, port_id: &str) -> usize {
    match (register_width(component), port_id) {
        (Some(width), "clk" | "en" | "rst") => usize::from(width),
        _ => match (memory_word_width(component), port_id) {
            (Some(width), "addr" | "we" | "clk" | "rst") => usize::from(width),
            _ => 1,
        },
    }
}

pub(crate) fn memory_word_width(component: &ProjectComponent) -> Option<u8> {
    matches!(component.type_id.as_str(), ROM_TYPE_ID | RAM_TYPE_ID).then(|| {
        component
            .properties
            .get("wordWidth")
            .and_then(serde_json::Value::as_u64)
            .and_then(|width| u8::try_from(width).ok())
            .unwrap_or(3)
    })
}

pub(crate) fn memory_address_width(component: &ProjectComponent) -> Option<u8> {
    matches!(component.type_id.as_str(), ROM_TYPE_ID | RAM_TYPE_ID).then(|| {
        component
            .properties
            .get("addressWidth")
            .and_then(serde_json::Value::as_u64)
            .and_then(|width| u8::try_from(width).ok())
            .unwrap_or(3)
    })
}

pub(crate) fn expand_memory(
    circuit_id: &str,
    component: &ProjectComponent,
    word_width: u8,
    address_width: u8,
    occupied: &mut BTreeSet<String>,
) -> MemoryExpansion {
    let is_rom = component.type_id == ROM_TYPE_ID;
    let kind = if is_rom { "rom" } else { "ram" };
    let type_id = if is_rom {
        "internal.rom_cell"
    } else {
        "internal.ram_cell"
    };
    let shape = SignalShape::new(word_width).expect("validated memory word width");
    let words = component
        .properties
        .get("contents")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .map(|word| {
            KnownWord::parse(
                word.as_str().expect("validated ROM word is a string"),
                shape,
            )
            .expect("validated ROM word")
        })
        .collect::<Vec<_>>();

    let mut lanes = Vec::with_capacity(usize::from(word_width));
    for bit in 0..word_width {
        let id = allocate_generated_id(&format!("{}#{kind}#bit{bit}", component.id), occupied);
        let lane_contents = words
            .iter()
            .map(|word| word.trit(bit))
            .collect::<Vec<Trit>>();
        let properties = if is_rom {
            serde_json::json!({
                "addressWidth": address_width,
                "contents": lane_contents,
            })
        } else {
            serde_json::json!({"addressWidth": address_width})
        };
        lanes.push(MemoryLane {
            component: ProjectComponent {
                id,
                type_id: type_id.into(),
                properties: ProjectProperties::from_value(properties)
                    .expect("generated memory properties are an object"),
            },
        });
    }

    let mut port_bits = BTreeMap::new();
    port_bits.insert(
        "addr".into(),
        (0..address_width)
            .map(|bit| {
                let internal_port = format!("addr{}", address_width - 1 - bit);
                lanes
                    .iter()
                    .map(|lane| (lane.component.id.clone(), internal_port.clone()))
                    .collect()
            })
            .collect(),
    );
    let output_port = if is_rom { "data" } else { "dout" };
    port_bits.insert(
        output_port.into(),
        lanes
            .iter()
            .map(|lane| vec![(lane.component.id.clone(), "q".into())])
            .collect(),
    );
    if !is_rom {
        port_bits.insert(
            "din".into(),
            lanes
                .iter()
                .map(|lane| vec![(lane.component.id.clone(), "d".into())])
                .collect(),
        );
        for control in ["we", "clk", "rst"] {
            port_bits.insert(
                control.into(),
                vec![
                    lanes
                        .iter()
                        .map(|lane| (lane.component.id.clone(), control.into()))
                        .collect(),
                ],
            );
        }
    }

    let macro_port =
        |port_id: &str| QualifiedPortRef::new(circuit_id, [] as [&str; 0], &component.id, port_id);
    let mut port_origins = BTreeMap::new();
    for lane in &lanes {
        for address_port in 0..address_width {
            port_origins.insert(
                QualifiedPortRef::new(
                    circuit_id,
                    [] as [&str; 0],
                    &lane.component.id,
                    format!("addr{address_port}"),
                ),
                macro_port("addr"),
            );
        }
        if is_rom {
            port_origins.insert(
                QualifiedPortRef::new(circuit_id, [] as [&str; 0], &lane.component.id, "q"),
                macro_port("data"),
            );
        } else {
            for (internal, public) in [
                ("d", "din"),
                ("we", "we"),
                ("clk", "clk"),
                ("rst", "rst"),
                ("q", "dout"),
            ] {
                port_origins.insert(
                    QualifiedPortRef::new(
                        circuit_id,
                        [] as [&str; 0],
                        &lane.component.id,
                        internal,
                    ),
                    macro_port(public),
                );
            }
        }
    }

    MemoryExpansion {
        lanes,
        port_bits,
        port_origins,
    }
}

pub(crate) fn expand_register(
    circuit_id: &str,
    component: &ProjectComponent,
    width: u8,
    occupied: &mut BTreeSet<String>,
) -> RegisterExpansion {
    let mut lanes = Vec::with_capacity(usize::from(width));
    for bit in 0..width {
        let id = allocate_generated_id(&format!("{}#register#bit{bit}", component.id), occupied);
        lanes.push(RegisterLane {
            component: ProjectComponent {
                id,
                type_id: "sequential.dff".into(),
                properties: ProjectProperties::default(),
            },
        });
    }

    let data = lanes
        .iter()
        .map(|lane| vec![(lane.component.id.clone(), "d".into())])
        .collect::<Vec<_>>();
    let output = lanes
        .iter()
        .map(|lane| vec![(lane.component.id.clone(), "q".into())])
        .collect::<Vec<_>>();
    let mut port_bits = BTreeMap::from([("d".into(), data), ("q".into(), output)]);
    for control in ["clk", "en", "rst"] {
        port_bits.insert(
            control.into(),
            vec![
                lanes
                    .iter()
                    .map(|lane| (lane.component.id.clone(), control.into()))
                    .collect(),
            ],
        );
    }

    let macro_port =
        |port_id: &str| QualifiedPortRef::new(circuit_id, [] as [&str; 0], &component.id, port_id);
    let mut port_origins = BTreeMap::new();
    for lane in &lanes {
        for port_id in ["d", "clk", "en", "rst", "q"] {
            port_origins.insert(
                QualifiedPortRef::new(circuit_id, [] as [&str; 0], &lane.component.id, port_id),
                macro_port(port_id),
            );
        }
    }

    RegisterExpansion {
        lanes,
        port_bits,
        port_origins,
    }
}

fn allocate_generated_id(base: &str, occupied: &mut BTreeSet<String>) -> String {
    let mut candidate = base.to_owned();
    while !occupied.insert(candidate.clone()) {
        candidate.push('#');
    }
    candidate
}

pub(crate) fn structural_lane_index(component_id: &str) -> Option<u8> {
    ["#register#bit", "#rom#bit", "#ram#bit"]
        .into_iter()
        .find_map(|marker| {
            let suffix = component_id.rsplit_once(marker)?.1;
            let digits = suffix
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>();
            digits.parse().ok()
        })
}
