use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::catalog::{ComponentKind, ComponentProperties, PortDirection};
use crate::diagnostic::{Diagnostic, Severity};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentInstance {
    pub id: String,
    pub type_id: String,
    #[serde(default)]
    pub properties: ComponentProperties,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub source_component_id: String,
    pub source_port_id: String,
    pub target_component_id: String,
    pub target_port_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CircuitDefinition {
    pub components: Vec<ComponentInstance>,
    pub connections: Vec<Connection>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct PortRef {
    pub component_id: String,
    pub port_id: String,
}

impl PortRef {
    pub fn new(component_id: impl Into<String>, port_id: impl Into<String>) -> Self {
        Self {
            component_id: component_id.into(),
            port_id: port_id.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedCircuit {
    components: Vec<ComponentInstance>,
    component_indexes: BTreeMap<String, usize>,
    component_kinds: BTreeMap<String, ComponentKind>,
    inbound_drivers: BTreeMap<PortRef, Vec<PortRef>>,
    downstream_components: BTreeMap<PortRef, Vec<String>>,
    connections: Vec<Connection>,
}

impl ValidatedCircuit {
    pub fn components(&self) -> &[ComponentInstance] {
        &self.components
    }

    pub fn component(&self, component_id: &str) -> Option<&ComponentInstance> {
        self.component_indexes
            .get(component_id)
            .map(|index| &self.components[*index])
    }

    pub fn component_index(&self, component_id: &str) -> Option<usize> {
        self.component_indexes.get(component_id).copied()
    }

    pub fn component_kind(&self, component_id: &str) -> Option<ComponentKind> {
        self.component_kinds.get(component_id).copied()
    }

    pub fn connections(&self) -> &[Connection] {
        &self.connections
    }

    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }

    pub fn drivers_for(&self, component_id: &str, port_id: &str) -> &[PortRef] {
        self.inbound_drivers
            .get(&PortRef::new(component_id, port_id))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn downstream_for(&self, component_id: &str, port_id: &str) -> &[String] {
        self.downstream_components
            .get(&PortRef::new(component_id, port_id))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationOutcome {
    pub circuit: ValidatedCircuit,
    pub warnings: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ConnectionEndpoints {
    source_component_id: String,
    source_port_id: String,
    target_component_id: String,
    target_port_id: String,
}

impl From<&Connection> for ConnectionEndpoints {
    fn from(connection: &Connection) -> Self {
        Self {
            source_component_id: connection.source_component_id.clone(),
            source_port_id: connection.source_port_id.clone(),
            target_component_id: connection.target_component_id.clone(),
            target_port_id: connection.target_port_id.clone(),
        }
    }
}

pub fn validate_circuit(
    definition: CircuitDefinition,
) -> Result<ValidationOutcome, Vec<Diagnostic>> {
    let mut diagnostics = BTreeSet::new();
    let mut components = definition.components;
    components.sort_by(|left, right| {
        (&left.id, &left.type_id, left.properties.value).cmp(&(
            &right.id,
            &right.type_id,
            right.properties.value,
        ))
    });

    let component_counts = components
        .iter()
        .fold(BTreeMap::new(), |mut counts, component| {
            *counts.entry(component.id.clone()).or_insert(0_usize) += 1;
            counts
        });

    for (component_id, count) in &component_counts {
        if *count > 1 {
            diagnostics.insert(Diagnostic::error(
                "DUPLICATE_COMPONENT_ID",
                format!("component id '{component_id}' is used more than once"),
                vec![component_id.clone()],
                vec![],
                vec![],
            ));
        }
    }

    let mut component_kinds = BTreeMap::new();
    for component in &components {
        let Some(kind) = ComponentKind::from_type_id(&component.type_id) else {
            diagnostics.insert(Diagnostic::error(
                "UNKNOWN_COMPONENT_TYPE",
                format!(
                    "component '{}' uses unknown type '{}'",
                    component.id, component.type_id
                ),
                vec![component.id.clone()],
                vec![],
                vec![],
            ));
            continue;
        };

        if component_counts.get(&component.id) == Some(&1) {
            component_kinds.insert(component.id.clone(), kind);
        }

        if !property_is_valid(kind, &component.properties) {
            diagnostics.insert(Diagnostic::error(
                "INVALID_PROPERTY",
                format!(
                    "component '{}' has an invalid value property for type '{}'",
                    component.id, component.type_id
                ),
                vec![component.id.clone()],
                vec![],
                vec![],
            ));
        }
    }

    let mut connections_by_endpoint: BTreeMap<ConnectionEndpoints, Vec<Connection>> =
        BTreeMap::new();
    for connection in definition.connections {
        connections_by_endpoint
            .entry(ConnectionEndpoints::from(&connection))
            .or_default()
            .push(connection);
    }

    let mut connections = Vec::with_capacity(connections_by_endpoint.len());
    for duplicate_group in connections_by_endpoint.values_mut() {
        duplicate_group.sort_by(|left, right| left.id.cmp(&right.id));
        let kept = duplicate_group
            .first()
            .expect("a grouped endpoint always has a connection");
        connections.push(kept.clone());

        for duplicate in duplicate_group.iter().skip(1) {
            diagnostics.insert(Diagnostic::warning(
                "DUPLICATE_CONNECTION",
                format!(
                    "connections '{}' and '{}' use the same endpoints; '{}' is ignored",
                    kept.id, duplicate.id, duplicate.id
                ),
                vec![
                    kept.source_component_id.clone(),
                    kept.target_component_id.clone(),
                ],
                vec![kept.id.clone(), duplicate.id.clone()],
                vec![kept.source_port_id.clone(), kept.target_port_id.clone()],
            ));
        }
    }

    for connection in &connections {
        validate_connection(
            connection,
            &component_counts,
            &component_kinds,
            &mut diagnostics,
        );
    }

    let diagnostics: Vec<_> = diagnostics.into_iter().collect();
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error)
    {
        return Err(diagnostics);
    }

    let component_indexes = components
        .iter()
        .enumerate()
        .map(|(index, component)| (component.id.clone(), index))
        .collect();
    let (inbound_drivers, downstream_components) = build_connection_indexes(&connections);
    let warnings = diagnostics;

    Ok(ValidationOutcome {
        circuit: ValidatedCircuit {
            components,
            component_indexes,
            component_kinds,
            inbound_drivers,
            downstream_components,
            connections,
        },
        warnings,
    })
}

fn property_is_valid(kind: ComponentKind, properties: &ComponentProperties) -> bool {
    match kind {
        ComponentKind::TritInput | ComponentKind::Constant => {
            properties.value.is_none_or(|value| value.is_known())
        }
        ComponentKind::Probe
        | ComponentKind::Buf
        | ComponentKind::Neg
        | ComponentKind::Min
        | ComponentKind::Max
        | ComponentKind::IsNeg
        | ComponentKind::IsZero
        | ComponentKind::IsPos
        | ComponentKind::Mux2
        | ComponentKind::Mux3 => properties.value.is_none(),
    }
}

fn validate_connection(
    connection: &Connection,
    component_counts: &BTreeMap<String, usize>,
    component_kinds: &BTreeMap<String, ComponentKind>,
    diagnostics: &mut BTreeSet<Diagnostic>,
) {
    let source_exists = component_counts.contains_key(&connection.source_component_id);
    let target_exists = component_counts.contains_key(&connection.target_component_id);

    if !source_exists {
        diagnostics.insert(Diagnostic::error(
            "UNKNOWN_COMPONENT",
            format!(
                "connection '{}' references unknown source component '{}'",
                connection.id, connection.source_component_id
            ),
            vec![connection.source_component_id.clone()],
            vec![connection.id.clone()],
            vec![connection.source_port_id.clone()],
        ));
    }
    if !target_exists {
        diagnostics.insert(Diagnostic::error(
            "UNKNOWN_COMPONENT",
            format!(
                "connection '{}' references unknown target component '{}'",
                connection.id, connection.target_component_id
            ),
            vec![connection.target_component_id.clone()],
            vec![connection.id.clone()],
            vec![connection.target_port_id.clone()],
        ));
    }

    let source_port = component_kinds
        .get(&connection.source_component_id)
        .and_then(|kind| {
            kind.port_descriptors()
                .into_iter()
                .find(|port| port.id == connection.source_port_id)
        });
    let target_port = component_kinds
        .get(&connection.target_component_id)
        .and_then(|kind| {
            kind.port_descriptors()
                .into_iter()
                .find(|port| port.id == connection.target_port_id)
        });

    if source_exists
        && component_kinds.contains_key(&connection.source_component_id)
        && source_port.is_none()
    {
        diagnostics.insert(Diagnostic::error(
            "UNKNOWN_PORT",
            format!(
                "connection '{}' references unknown source port '{}.{}'",
                connection.id, connection.source_component_id, connection.source_port_id
            ),
            vec![connection.source_component_id.clone()],
            vec![connection.id.clone()],
            vec![connection.source_port_id.clone()],
        ));
    }
    if target_exists
        && component_kinds.contains_key(&connection.target_component_id)
        && target_port.is_none()
    {
        diagnostics.insert(Diagnostic::error(
            "UNKNOWN_PORT",
            format!(
                "connection '{}' references unknown target port '{}.{}'",
                connection.id, connection.target_component_id, connection.target_port_id
            ),
            vec![connection.target_component_id.clone()],
            vec![connection.id.clone()],
            vec![connection.target_port_id.clone()],
        ));
    }

    if let (Some(source_port), Some(target_port)) = (source_port, target_port)
        && (source_port.direction != PortDirection::Output
            || target_port.direction != PortDirection::Input)
    {
        diagnostics.insert(Diagnostic::error(
            "INVALID_PORT_DIRECTION",
            format!(
                "connection '{}' must run from an output port to an input port",
                connection.id
            ),
            vec![
                connection.source_component_id.clone(),
                connection.target_component_id.clone(),
            ],
            vec![connection.id.clone()],
            vec![
                connection.source_port_id.clone(),
                connection.target_port_id.clone(),
            ],
        ));
    }
}

fn build_connection_indexes(
    connections: &[Connection],
) -> (
    BTreeMap<PortRef, Vec<PortRef>>,
    BTreeMap<PortRef, Vec<String>>,
) {
    let mut inbound_sets: BTreeMap<PortRef, BTreeSet<PortRef>> = BTreeMap::new();
    let mut downstream_sets: BTreeMap<PortRef, BTreeSet<String>> = BTreeMap::new();

    for connection in connections {
        let source = PortRef::new(&connection.source_component_id, &connection.source_port_id);
        let target = PortRef::new(&connection.target_component_id, &connection.target_port_id);
        inbound_sets
            .entry(target)
            .or_default()
            .insert(source.clone());
        downstream_sets
            .entry(source)
            .or_default()
            .insert(connection.target_component_id.clone());
    }

    let inbound_drivers = inbound_sets
        .into_iter()
        .map(|(target, drivers)| (target, drivers.into_iter().collect()))
        .collect();
    let downstream_components = downstream_sets
        .into_iter()
        .map(|(source, components)| (source, components.into_iter().collect()))
        .collect();
    (inbound_drivers, downstream_components)
}
