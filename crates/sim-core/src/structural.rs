use std::collections::{BTreeMap, BTreeSet};

use crate::project::{ProjectComponent, ProjectProperties, QualifiedPortRef};

pub const REGISTER_TYPE_ID: &str = "sequential.register";

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
    register_width(component).map_or(1, usize::from)
}

pub(crate) fn endpoint_multiplicity(component: &ProjectComponent, port_id: &str) -> usize {
    match (register_width(component), port_id) {
        (Some(width), "clk" | "en" | "rst") => usize::from(width),
        _ => 1,
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
