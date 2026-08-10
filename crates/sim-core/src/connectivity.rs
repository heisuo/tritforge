use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::catalog::PortDirection;
use crate::diagnostic::Severity;
use crate::hierarchy::{
    CompiledProject, FlatPortRef, MAX_ANALYSIS_EDGES, MAX_EXPANDED_COMPONENTS,
    MAX_EXPANDED_CONNECTIONS, MAX_PROJECTION_ENDPOINTS, MAX_PROVENANCE_REFERENCES, compile_project,
};
use crate::project::{
    ProjectCircuit, ProjectCircuitKind, ProjectComponent, ProjectConnection, ProjectDiagnostic,
    ProjectDiagnosticSet, ProjectDocument, ProjectDocumentV3, ProjectLocation, ProjectProperties,
    QualifiedComponentRef, QualifiedConnectionRef, QualifiedPortRef,
};
use crate::project_validation::{ResolvedProjectPort, resolve_project_ports, validate_project};

const MODULE_INPUT: &str = "project.module_input";
const MODULE_OUTPUT: &str = "project.module_output";
const MODULE_INSTANCE: &str = "project.module_instance";
const JUNCTION: &str = "wiring.junction";
const TUNNEL: &str = "wiring.tunnel";
const SPLITTER: &str = "wiring.splitter";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScalarBitEndpoint {
    pub scalar_port: Option<QualifiedPortRef>,
    pub scalar_net: Option<QualifiedNetRef>,
    pub flat_endpoints: Vec<FlatPortRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualifiedNetRef {
    pub circuit_id: String,
    pub instance_path: Vec<String>,
    pub net_id: String,
}

impl QualifiedNetRef {
    fn new<I, S>(circuit_id: impl Into<String>, instance_path: I, net_id: impl Into<String>) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            circuit_id: circuit_id.into(),
            instance_path: instance_path.into_iter().map(Into::into).collect(),
            net_id: net_id.into(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReassemblyNet {
    pub scalar_drivers: Vec<QualifiedPortRef>,
    pub scalar_consumers: Vec<QualifiedPortRef>,
    pub flat_drivers: Vec<FlatPortRef>,
    pub flat_consumers: Vec<FlatPortRef>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReassemblyMetadata {
    pub ports: BTreeMap<QualifiedPortRef, Vec<ScalarBitEndpoint>>,
    pub nets: BTreeMap<QualifiedNetRef, ReassemblyNet>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityProvenance {
    pub components: BTreeMap<QualifiedComponentRef, QualifiedComponentRef>,
    pub connections: BTreeMap<QualifiedConnectionRef, Vec<QualifiedConnectionRef>>,
    pub wire_bits: BTreeMap<QualifiedWireBitRef, Vec<QualifiedConnectionRef>>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualifiedWireBitRef {
    pub circuit_id: String,
    pub instance_path: Vec<String>,
    pub wire_id: String,
    pub bit_index: u8,
}

impl QualifiedWireBitRef {
    pub fn new<I, S>(
        circuit_id: impl Into<String>,
        instance_path: I,
        wire_id: impl Into<String>,
        bit_index: u8,
    ) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            circuit_id: circuit_id.into(),
            instance_path: instance_path.into_iter().map(Into::into).collect(),
            wire_id: wire_id.into(),
            bit_index,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredProjectV3 {
    pub project: ProjectDocument,
    pub reassembly: ReassemblyMetadata,
    pub provenance: ConnectivityProvenance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledProjectV3 {
    pub lowered: LoweredProjectV3,
    pub compiled: CompiledProject,
    pub reassembly: ReassemblyMetadata,
    pub wire_provenance: BTreeMap<String, Vec<QualifiedConnectionRef>>,
    pub reverse_wire_provenance: BTreeMap<QualifiedWireBitRef, Vec<String>>,
}

#[derive(Debug, Clone)]
struct InterfacePort {
    id: String,
    direction: PortDirection,
    width: u8,
    boundary_component_id: String,
    scalar_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct BitNode {
    component_id: String,
    port_id: String,
    bit: u8,
}

#[derive(Debug, Clone)]
struct BitInfo {
    direction: PortDirection,
    scalar_component_id: Option<String>,
    scalar_port_id: Option<String>,
}

#[derive(Debug, Default)]
struct UnionFind {
    parents: BTreeMap<BitNode, BitNode>,
}

impl UnionFind {
    fn insert(&mut self, node: BitNode) {
        self.parents.entry(node.clone()).or_insert(node);
    }

    fn root(&mut self, node: &BitNode) -> Option<BitNode> {
        let mut cursor = node.clone();
        let mut path = Vec::new();
        loop {
            let parent = self.parents.get(&cursor)?;
            if *parent == cursor {
                for child in path {
                    self.parents.insert(child, cursor.clone());
                }
                return Some(cursor);
            }
            path.push(cursor);
            cursor = parent.clone();
        }
    }

    fn union(&mut self, left: &BitNode, right: &BitNode) {
        let (Some(left_root), Some(right_root)) = (self.root(left), self.root(right)) else {
            return;
        };
        if left_root == right_root {
            return;
        }
        let (root, child) = if left_root < right_root {
            (left_root, right_root)
        } else {
            (right_root, left_root)
        };
        self.parents.insert(child, root);
    }
}

#[derive(Debug, Default)]
struct NetPlan {
    drivers: BTreeSet<(String, String)>,
    consumers: BTreeSet<(String, String)>,
    wires: BTreeSet<QualifiedConnectionRef>,
    wire_bits: BTreeSet<QualifiedWireBitRef>,
}

#[derive(Debug)]
struct CircuitLowering {
    circuit: ProjectCircuit,
    reassembly: ReassemblyMetadata,
    provenance: ConnectivityProvenance,
}

pub fn lower_project_v3(
    project: ProjectDocumentV3,
) -> Result<LoweredProjectV3, Vec<ProjectDiagnostic>> {
    let active_circuit_id = project.root_circuit_id.clone();
    lower_project_v3_for_active(project, &active_circuit_id)
}

fn lower_project_v3_for_active(
    project: ProjectDocumentV3,
    active_circuit_id: &str,
) -> Result<LoweredProjectV3, Vec<ProjectDiagnostic>> {
    let mut diagnostics = ProjectDiagnosticSet::new();
    validate_v3_header_and_ids(&project, &mut diagnostics);

    let circuit_counts = count_ids(project.circuits.iter().map(|circuit| circuit.id.as_str()));
    let unique_circuits: BTreeMap<_, _> = project
        .circuits
        .iter()
        .filter(|circuit| circuit_counts.get(&circuit.id) == Some(&1))
        .map(|circuit| (circuit.id.clone(), circuit))
        .collect();

    let mut resolved_ports = BTreeMap::new();
    for circuit in unique_circuits.values() {
        let component_counts = count_ids(
            circuit
                .components
                .iter()
                .map(|component| component.id.as_str()),
        );
        let wire_counts = count_ids(circuit.wires.iter().map(|wire| wire.id.as_str()));
        for (component_id, _) in component_counts.iter().filter(|(_, count)| **count > 1) {
            diagnostics.insert(v3_error(
                "DUPLICATE_COMPONENT_ID",
                format!("component id '{component_id}' is used more than once"),
                &circuit.id,
                &[component_id],
                &[],
                &[],
            ));
        }
        for (wire_id, _) in wire_counts.iter().filter(|(_, count)| **count > 1) {
            diagnostics.insert(v3_error(
                "DUPLICATE_WIRE_ID",
                format!("wire id '{wire_id}' is used more than once"),
                &circuit.id,
                &[],
                &[wire_id],
                &[],
            ));
        }
        for component in &circuit.components {
            if component_counts.get(&component.id) != Some(&1) {
                continue;
            }
            if component.type_id == MODULE_INSTANCE {
                if component
                    .properties
                    .module_id()
                    .is_none_or(|module_id| module_id.trim().is_empty())
                    || component
                        .properties
                        .label()
                        .is_none_or(|label| label.trim().is_empty())
                    || !component
                        .properties
                        .keys()
                        .all(|key| matches!(key, "moduleId" | "label"))
                {
                    diagnostics.insert(v3_error(
                        "INVALID_PROPERTY",
                        format!("module instance '{}' has invalid properties", component.id),
                        &circuit.id,
                        &[&component.id],
                        &[],
                        &[],
                    ));
                }
                continue;
            }
            match resolve_project_ports(&component.type_id, &component.properties) {
                Ok(ports) => {
                    resolved_ports.insert((circuit.id.clone(), component.id.clone()), ports);
                }
                Err(error) => {
                    diagnostics.insert(v3_error(
                        error.code(),
                        format!("component '{}': {error}", component.id),
                        &circuit.id,
                        &[&component.id],
                        &[],
                        &[],
                    ));
                }
            }
        }
    }

    let mut interfaces = build_interfaces(&unique_circuits, &resolved_ports, &mut diagnostics);
    assign_scalar_interface_ids(&mut interfaces);
    resolve_instances(
        &unique_circuits,
        &interfaces,
        &mut resolved_ports,
        &mut diagnostics,
    );
    validate_wires_and_tunnels(&unique_circuits, &resolved_ports, &mut diagnostics);

    let diagnostics = diagnostics.into_vec();
    if has_errors(&diagnostics) {
        return Err(diagnostics);
    }
    preflight_connectivity(&unique_circuits, &resolved_ports, active_circuit_id)?;

    let mut lowered_circuits = Vec::with_capacity(unique_circuits.len());
    let mut reassembly = ReassemblyMetadata::default();
    let mut provenance = ConnectivityProvenance::default();
    for circuit in unique_circuits.values() {
        let lowered = lower_circuit(circuit, &resolved_ports, &interfaces)?;
        lowered_circuits.push(lowered.circuit);
        reassembly.ports.extend(lowered.reassembly.ports);
        reassembly.nets.extend(lowered.reassembly.nets);
        provenance.components.extend(lowered.provenance.components);
        provenance
            .connections
            .extend(lowered.provenance.connections);
        provenance.wire_bits.extend(lowered.provenance.wire_bits);
    }
    lowered_circuits.sort_by(|left, right| left.id.cmp(&right.id));

    let scalar_project = ProjectDocument {
        format: "logsim-ternary".into(),
        version: 2,
        root_circuit_id: project.root_circuit_id,
        circuits: lowered_circuits,
    };
    if let Err(scalar_diagnostics) = validate_project(scalar_project.clone()) {
        return Err(remap_diagnostics(
            &scalar_diagnostics,
            &provenance,
            &reassembly,
        ));
    }

    Ok(LoweredProjectV3 {
        project: scalar_project,
        reassembly,
        provenance,
    })
}

pub fn compile_project_v3(
    project: ProjectDocumentV3,
    active_circuit_id: &str,
) -> Result<CompiledProjectV3, Vec<ProjectDiagnostic>> {
    let lowered = lower_project_v3_for_active(project, active_circuit_id)?;
    let validated = validate_project(lowered.project.clone())
        .map_err(|errors| remap_diagnostics(&errors, &lowered.provenance, &lowered.reassembly))?;
    let compiled = compile_project(&validated, active_circuit_id)
        .map_err(|errors| remap_diagnostics(&errors, &lowered.provenance, &lowered.reassembly))?;
    check_compiled_provenance_amplification(&lowered.provenance, &compiled)?;
    let reassembly = expand_reassembly(&lowered, &compiled, active_circuit_id);
    let wire_provenance = compose_wire_provenance(&lowered.provenance, &compiled);
    let reverse_wire_provenance =
        compose_reverse_wire_provenance(&lowered, &compiled, active_circuit_id);
    Ok(CompiledProjectV3 {
        lowered,
        compiled,
        reassembly,
        wire_provenance,
        reverse_wire_provenance,
    })
}

fn check_compiled_provenance_amplification(
    provenance: &ConnectivityProvenance,
    compiled: &CompiledProject,
) -> Result<(), Vec<ProjectDiagnostic>> {
    let mut count = 0_usize;
    for scalar_connections in compiled.provenance.connections.values() {
        for scalar_connection in scalar_connections {
            let static_ref = QualifiedConnectionRef::new(
                &scalar_connection.circuit_id,
                [] as [&str; 0],
                &scalar_connection.connection_id,
            );
            let Some(wires) = provenance.connections.get(&static_ref) else {
                continue;
            };
            count = count.checked_add(wires.len()).ok_or_else(|| {
                vec![compiled_provenance_limit(
                    scalar_connection,
                    wires.first(),
                    usize::MAX,
                )]
            })?;
            if count > MAX_PROVENANCE_REFERENCES {
                return Err(vec![compiled_provenance_limit(
                    scalar_connection,
                    wires.first(),
                    count,
                )]);
            }
        }
    }
    Ok(())
}

fn compiled_provenance_limit(
    scalar_connection: &QualifiedConnectionRef,
    wire: Option<&QualifiedConnectionRef>,
    count: usize,
) -> ProjectDiagnostic {
    let wire_ref = wire.map(|wire| {
        QualifiedConnectionRef::new(
            &wire.circuit_id,
            scalar_connection.instance_path.iter().cloned(),
            &wire.connection_id,
        )
    });
    ProjectDiagnostic {
        code: "HIERARCHY_EXPANSION_LIMIT".into(),
        severity: Severity::Error,
        message: format!(
            "expanded provenance reference count is at least {count}, exceeding {MAX_PROVENANCE_REFERENCES}"
        ),
        primary_location: wire_ref.clone().map(ProjectLocation::Connection),
        component_refs: Vec::new(),
        connection_refs: wire_ref.into_iter().collect(),
        port_refs: Vec::new(),
    }
}

fn validate_v3_header_and_ids(project: &ProjectDocumentV3, diagnostics: &mut ProjectDiagnosticSet) {
    if project.format != "logsim-ternary" {
        diagnostics.insert(v3_error(
            "INVALID_PROJECT_FORMAT",
            format!("unsupported project format '{}'", project.format),
            &project.root_circuit_id,
            &[],
            &[],
            &[],
        ));
    }
    if project.version != 3 {
        diagnostics.insert(v3_error(
            "UNSUPPORTED_PROJECT_VERSION",
            format!("unsupported project version '{}'", project.version),
            &project.root_circuit_id,
            &[],
            &[],
            &[],
        ));
    }
    let counts = count_ids(project.circuits.iter().map(|circuit| circuit.id.as_str()));
    for (id, _) in counts.iter().filter(|(_, count)| **count > 1) {
        diagnostics.insert(v3_error(
            "DUPLICATE_CIRCUIT_ID",
            format!("circuit id '{id}' is used more than once"),
            id,
            &[],
            &[],
            &[],
        ));
    }
    if project
        .circuits
        .iter()
        .any(|circuit| circuit.id.trim().is_empty())
    {
        diagnostics.insert(v3_error(
            "INVALID_CIRCUIT_ID",
            "circuit IDs must not be empty".into(),
            &project.root_circuit_id,
            &[],
            &[],
            &[],
        ));
    }
    if project
        .circuits
        .iter()
        .any(|circuit| circuit.name.trim().is_empty())
    {
        diagnostics.insert(v3_error(
            "INVALID_CIRCUIT_NAME",
            "circuit names must not be empty".into(),
            &project.root_circuit_id,
            &[],
            &[],
            &[],
        ));
    }
    let mains = project
        .circuits
        .iter()
        .filter(|circuit| circuit.kind == ProjectCircuitKind::Main)
        .count();
    let root_is_unique_main = project
        .circuits
        .iter()
        .filter(|circuit| circuit.id == project.root_circuit_id)
        .collect::<Vec<_>>();
    if mains != 1
        || root_is_unique_main.len() != 1
        || root_is_unique_main[0].kind != ProjectCircuitKind::Main
    {
        diagnostics.insert(v3_error(
            "INVALID_ROOT_CIRCUIT",
            "project must contain exactly one main circuit matching rootCircuitId".into(),
            &project.root_circuit_id,
            &[],
            &[],
            &[],
        ));
    }
}

fn build_interfaces(
    circuits: &BTreeMap<String, &crate::project::ProjectCircuitV3>,
    resolved: &BTreeMap<(String, String), Vec<ResolvedProjectPort>>,
    diagnostics: &mut ProjectDiagnosticSet,
) -> BTreeMap<String, Vec<InterfacePort>> {
    let mut interfaces = BTreeMap::new();
    for circuit in circuits
        .values()
        .filter(|circuit| circuit.kind == ProjectCircuitKind::Module)
    {
        let mut ports = Vec::new();
        let mut ids: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for component in &circuit.components {
            let direction = match component.type_id.as_str() {
                MODULE_INPUT => PortDirection::Input,
                MODULE_OUTPUT => PortDirection::Output,
                _ => continue,
            };
            let (Some(port_id), Some(resolved_port)) = (
                component.properties.port_id(),
                resolved
                    .get(&(circuit.id.clone(), component.id.clone()))
                    .and_then(|ports| ports.first()),
            ) else {
                continue;
            };
            ids.entry(port_id.to_owned())
                .or_default()
                .push(component.id.clone());
            ports.push(InterfacePort {
                id: port_id.to_owned(),
                direction,
                width: resolved_port.shape.width(),
                boundary_component_id: component.id.clone(),
                scalar_ids: Vec::new(),
            });
        }
        for (port_id, component_ids) in ids {
            if component_ids.len() > 1 {
                let components = component_ids.iter().map(String::as_str).collect::<Vec<_>>();
                let port_refs = component_ids
                    .iter()
                    .map(|component_id| (component_id.as_str(), port_id.as_str()))
                    .collect::<Vec<_>>();
                diagnostics.insert(v3_error(
                    "DUPLICATE_MODULE_PORT_ID",
                    format!("module port id '{port_id}' is used more than once"),
                    &circuit.id,
                    &components,
                    &[],
                    &port_refs,
                ));
            }
        }
        ports.sort_by(|left, right| left.id.cmp(&right.id));
        interfaces.insert(circuit.id.clone(), ports);
    }
    interfaces
}

fn assign_scalar_interface_ids(interfaces: &mut BTreeMap<String, Vec<InterfacePort>>) {
    for ports in interfaces.values_mut() {
        let mut occupied = BTreeSet::new();
        for port in ports {
            for bit in 0..port.width {
                let base = format!("{}#bit{bit}", port.id);
                port.scalar_ids.push(allocate_id(&base, &mut occupied));
            }
        }
    }
}

fn resolve_instances(
    circuits: &BTreeMap<String, &crate::project::ProjectCircuitV3>,
    interfaces: &BTreeMap<String, Vec<InterfacePort>>,
    resolved: &mut BTreeMap<(String, String), Vec<ResolvedProjectPort>>,
    diagnostics: &mut ProjectDiagnosticSet,
) {
    for circuit in circuits.values() {
        for component in &circuit.components {
            if component.type_id != MODULE_INSTANCE {
                continue;
            }
            let Some(module_id) = component.properties.module_id() else {
                continue;
            };
            let Some(target) = circuits.get(module_id) else {
                diagnostics.insert(v3_error(
                    "UNKNOWN_MODULE",
                    format!(
                        "module instance '{}' references unknown module '{module_id}'",
                        component.id
                    ),
                    &circuit.id,
                    &[&component.id],
                    &[],
                    &[],
                ));
                continue;
            };
            if target.kind != ProjectCircuitKind::Module {
                diagnostics.insert(v3_error(
                    "MODULE_REFERENCE_NOT_MODULE",
                    format!(
                        "module instance '{}' references non-module circuit '{module_id}'",
                        component.id
                    ),
                    &circuit.id,
                    &[&component.id],
                    &[],
                    &[],
                ));
                continue;
            }
            let ports = interfaces
                .get(module_id)
                .into_iter()
                .flatten()
                .filter_map(|port| {
                    crate::signal::SignalShape::new(port.width)
                        .ok()
                        .map(|shape| ResolvedProjectPort {
                            id: port.id.clone(),
                            direction: port.direction,
                            shape,
                        })
                })
                .collect();
            resolved.insert((circuit.id.clone(), component.id.clone()), ports);
        }
    }
}

fn validate_wires_and_tunnels(
    circuits: &BTreeMap<String, &crate::project::ProjectCircuitV3>,
    resolved: &BTreeMap<(String, String), Vec<ResolvedProjectPort>>,
    diagnostics: &mut ProjectDiagnosticSet,
) {
    for circuit in circuits.values() {
        let component_counts = count_ids(
            circuit
                .components
                .iter()
                .map(|component| component.id.as_str()),
        );
        let components: BTreeMap<_, _> = circuit
            .components
            .iter()
            .map(|component| (component.id.as_str(), component))
            .collect();
        for wire in &circuit.wires {
            let mut endpoint_ports = Vec::new();
            for endpoint in [&wire.endpoint_a, &wire.endpoint_b] {
                if component_counts.get(&endpoint.component_id) != Some(&1) {
                    if !component_counts.contains_key(&endpoint.component_id) {
                        diagnostics.insert(v3_error(
                            "UNKNOWN_COMPONENT",
                            format!(
                                "wire '{}' references unknown component '{}'",
                                wire.id, endpoint.component_id
                            ),
                            &circuit.id,
                            &[&endpoint.component_id],
                            &[&wire.id],
                            &[],
                        ));
                    }
                    continue;
                }
                let Some(component) = components.get(endpoint.component_id.as_str()) else {
                    continue;
                };
                let port = resolved
                    .get(&(circuit.id.clone(), component.id.clone()))
                    .and_then(|ports| ports.iter().find(|port| port.id == endpoint.port_id));
                if let Some(port) = port {
                    endpoint_ports.push((endpoint, port));
                } else if resolved.contains_key(&(circuit.id.clone(), component.id.clone())) {
                    diagnostics.insert(v3_error(
                        if component.type_id == MODULE_INSTANCE {
                            "UNKNOWN_MODULE_PORT"
                        } else {
                            "UNKNOWN_PORT"
                        },
                        format!(
                            "wire '{}' references unknown port '{}.{}'",
                            wire.id, endpoint.component_id, endpoint.port_id
                        ),
                        &circuit.id,
                        &[&endpoint.component_id],
                        &[&wire.id],
                        &[(&endpoint.component_id, &endpoint.port_id)],
                    ));
                }
            }
            if endpoint_ports.len() == 2 && endpoint_ports[0].1.shape != endpoint_ports[1].1.shape {
                diagnostics.insert(v3_error(
                    "WIDTH_MISMATCH",
                    format!(
                        "wire '{}' connects width {} to width {}",
                        wire.id,
                        endpoint_ports[0].1.shape.width(),
                        endpoint_ports[1].1.shape.width()
                    ),
                    &circuit.id,
                    &[
                        &endpoint_ports[0].0.component_id,
                        &endpoint_ports[1].0.component_id,
                    ],
                    &[&wire.id],
                    &[
                        (
                            &endpoint_ports[0].0.component_id,
                            &endpoint_ports[0].0.port_id,
                        ),
                        (
                            &endpoint_ports[1].0.component_id,
                            &endpoint_ports[1].0.port_id,
                        ),
                    ],
                ));
            }
        }

        let mut tunnel_widths: BTreeMap<&str, BTreeMap<u8, Vec<&ProjectComponent>>> =
            BTreeMap::new();
        for component in &circuit.components {
            if component.type_id != TUNNEL {
                continue;
            }
            let (Some(label), Some(width)) = (
                component.properties.label(),
                resolved
                    .get(&(circuit.id.clone(), component.id.clone()))
                    .and_then(|ports| ports.first())
                    .map(|port| port.shape.width()),
            ) else {
                continue;
            };
            tunnel_widths
                .entry(label)
                .or_default()
                .entry(width)
                .or_default()
                .push(component);
        }
        for (label, widths) in tunnel_widths {
            if widths.len() > 1 {
                let component_ids = widths
                    .values()
                    .flatten()
                    .map(|component| component.id.as_str())
                    .collect::<Vec<_>>();
                let port_refs = component_ids
                    .iter()
                    .map(|component_id| (*component_id, "net"))
                    .collect::<Vec<_>>();
                diagnostics.insert(v3_error(
                    "TUNNEL_WIDTH_CONFLICT",
                    format!("tunnel label '{label}' is used with conflicting widths"),
                    &circuit.id,
                    &component_ids,
                    &[],
                    &port_refs,
                ));
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct ConnectivityMetrics {
    reassembly_entries: usize,
    reassembly_endpoints: usize,
    wire_bit_edges: usize,
    generated_connections: usize,
    provenance_references: usize,
}

impl ConnectivityMetrics {
    fn checked_add(self, other: Self) -> Option<Self> {
        Some(Self {
            reassembly_entries: self
                .reassembly_entries
                .checked_add(other.reassembly_entries)?,
            reassembly_endpoints: self
                .reassembly_endpoints
                .checked_add(other.reassembly_endpoints)?,
            wire_bit_edges: self.wire_bit_edges.checked_add(other.wire_bit_edges)?,
            generated_connections: self
                .generated_connections
                .checked_add(other.generated_connections)?,
            provenance_references: self
                .provenance_references
                .checked_add(other.provenance_references)?,
        })
    }

    fn value(self, metric: ConnectivityMetric) -> usize {
        match metric {
            ConnectivityMetric::ReassemblyEntries => self.reassembly_entries,
            ConnectivityMetric::ReassemblyEndpoints => self.reassembly_endpoints,
            ConnectivityMetric::WireBitEdges => self.wire_bit_edges,
            ConnectivityMetric::GeneratedConnections => self.generated_connections,
            ConnectivityMetric::ProvenanceReferences => self.provenance_references,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum ConnectivityMetric {
    ReassemblyEntries,
    ReassemblyEndpoints,
    WireBitEdges,
    GeneratedConnections,
    ProvenanceReferences,
}

fn preflight_connectivity(
    circuits: &BTreeMap<String, &crate::project::ProjectCircuitV3>,
    resolved: &BTreeMap<(String, String), Vec<ResolvedProjectPort>>,
    active_circuit_id: &str,
) -> Result<(), Vec<ProjectDiagnostic>> {
    let mut local_metrics = BTreeMap::new();
    for circuit in circuits.values() {
        let shape = count_local_connectivity_shape(circuit, resolved)?;
        local_metrics.insert(
            circuit.id.clone(),
            analyze_local_connectivity(circuit, resolved, shape)?,
        );
    }

    let Some(order) = v3_dependency_postorder(active_circuit_id, circuits) else {
        return Ok(());
    };
    let mut expanded = BTreeMap::new();
    for circuit_id in order {
        let Some(circuit) = circuits.get(&circuit_id) else {
            return Ok(());
        };
        let local = *local_metrics
            .get(&circuit_id)
            .unwrap_or(&ConnectivityMetrics::default());
        let mut total = local;
        let mut children = ConnectivityMetrics::default();
        let mut growth_instance = None;
        let mut instances = circuit
            .components
            .iter()
            .filter(|component| component.type_id == MODULE_INSTANCE)
            .collect::<Vec<_>>();
        instances.sort_by(|left, right| left.id.cmp(&right.id));
        for instance in instances {
            let Some(module_id) = instance.properties.module_id() else {
                continue;
            };
            let Some(child) = expanded.get(module_id).copied() else {
                continue;
            };
            growth_instance = Some(instance);
            children = children.checked_add(child).ok_or_else(|| {
                vec![hierarchy_connectivity_limit(
                    circuit,
                    instance,
                    "hierarchy connectivity count overflowed usize",
                )]
            })?;
            total = total.checked_add(child).ok_or_else(|| {
                vec![hierarchy_connectivity_limit(
                    circuit,
                    instance,
                    "hierarchy connectivity count overflowed usize",
                )]
            })?;
        }
        let cross_references = local
            .generated_connections
            .checked_mul(children.provenance_references)
            .and_then(|left| {
                local
                    .provenance_references
                    .checked_mul(children.generated_connections)
                    .and_then(|right| left.checked_add(right))
            })
            .ok_or_else(|| {
                vec![connectivity_cross_limit(
                    circuit,
                    growth_instance,
                    "hierarchy provenance amplification overflowed usize",
                )]
            })?;
        total.provenance_references = total
            .provenance_references
            .checked_add(cross_references)
            .ok_or_else(|| {
                vec![connectivity_cross_limit(
                    circuit,
                    growth_instance,
                    "hierarchy provenance amplification overflowed usize",
                )]
            })?;
        expanded.insert(circuit_id, total);
    }
    let Some(active_metrics) = expanded.get(active_circuit_id).copied() else {
        return Ok(());
    };

    check_expanded_metric(
        active_metrics,
        ConnectivityMetric::ReassemblyEntries,
        MAX_PROJECTION_ENDPOINTS,
        "expanded reassembly entry count",
        active_circuit_id,
        circuits,
        &expanded,
    )?;
    check_expanded_metric(
        active_metrics,
        ConnectivityMetric::ReassemblyEndpoints,
        MAX_PROJECTION_ENDPOINTS,
        "expanded reassembly endpoint count",
        active_circuit_id,
        circuits,
        &expanded,
    )?;
    check_expanded_metric(
        active_metrics,
        ConnectivityMetric::WireBitEdges,
        MAX_ANALYSIS_EDGES,
        "expanded wire-bit analysis edge count",
        active_circuit_id,
        circuits,
        &expanded,
    )?;
    check_expanded_metric(
        active_metrics,
        ConnectivityMetric::GeneratedConnections,
        MAX_EXPANDED_CONNECTIONS,
        "expanded generated connection count",
        active_circuit_id,
        circuits,
        &expanded,
    )?;
    check_expanded_metric(
        active_metrics,
        ConnectivityMetric::ProvenanceReferences,
        MAX_PROVENANCE_REFERENCES,
        "expanded provenance reference count",
        active_circuit_id,
        circuits,
        &expanded,
    )?;
    Ok(())
}

fn connectivity_cross_limit(
    circuit: &crate::project::ProjectCircuitV3,
    instance: Option<&ProjectComponent>,
    message: impl Into<String>,
) -> ProjectDiagnostic {
    let message = message.into();
    match instance {
        Some(instance) => hierarchy_connectivity_limit(circuit, instance, message),
        None => connectivity_local_limit(circuit, message),
    }
}

fn count_local_connectivity_shape(
    circuit: &crate::project::ProjectCircuitV3,
    resolved: &BTreeMap<(String, String), Vec<ResolvedProjectPort>>,
) -> Result<ConnectivityMetrics, Vec<ProjectDiagnostic>> {
    let mut metrics = ConnectivityMetrics::default();
    let mut components = circuit.components.iter().collect::<Vec<_>>();
    components.sort_by(|left, right| left.id.cmp(&right.id));
    for component in &components {
        for port in resolved
            .get(&(circuit.id.clone(), component.id.clone()))
            .into_iter()
            .flatten()
        {
            metrics.reassembly_entries =
                metrics.reassembly_entries.checked_add(1).ok_or_else(|| {
                    vec![limit_error(
                        circuit,
                        Some(component),
                        "reassembly entry count overflowed usize",
                    )]
                })?;
            metrics.reassembly_endpoints = metrics
                .reassembly_endpoints
                .checked_add(usize::from(port.shape.width()))
                .ok_or_else(|| {
                    vec![limit_error(
                        circuit,
                        Some(component),
                        "reassembly endpoint count overflowed usize",
                    )]
                })?;
        }
    }
    if metrics.reassembly_entries > MAX_PROJECTION_ENDPOINTS
        || metrics.reassembly_endpoints > MAX_PROJECTION_ENDPOINTS
    {
        return Err(vec![limit_error(
            circuit,
            components.last().copied(),
            format!(
                "expanded reassembly endpoint count {} exceeds projection endpoint limit {}",
                metrics.reassembly_endpoints, MAX_PROJECTION_ENDPOINTS
            ),
        )]);
    }

    let mut wires = circuit.wires.iter().collect::<Vec<_>>();
    wires.sort_by(|left, right| left.id.cmp(&right.id));
    for wire in wires {
        let width = usize::from(
            resolved_width(resolved, &circuit.id, &wire.endpoint_a).unwrap_or_default(),
        );
        metrics.wire_bit_edges = metrics.wire_bit_edges.checked_add(width).ok_or_else(|| {
            vec![wire_limit_error(
                circuit,
                wire,
                "wire-bit analysis edge count overflowed usize",
            )]
        })?;
        if metrics.wire_bit_edges > MAX_ANALYSIS_EDGES {
            return Err(vec![wire_limit_error(
                circuit,
                wire,
                format!(
                    "wire-bit analysis edge count {} exceeds {}",
                    metrics.wire_bit_edges, MAX_ANALYSIS_EDGES
                ),
            )]);
        }
    }

    let mut tunnels: BTreeMap<&str, (usize, usize, &ProjectComponent)> = BTreeMap::new();
    for component in &components {
        if component.type_id != TUNNEL {
            continue;
        }
        let Some(label) = component.properties.label() else {
            continue;
        };
        let width = resolved
            .get(&(circuit.id.clone(), component.id.clone()))
            .and_then(|ports| ports.first())
            .map(|port| usize::from(port.shape.width()))
            .unwrap_or_default();
        let entry = tunnels.entry(label).or_insert((0, width, component));
        entry.0 += 1;
        entry.2 = component;
    }
    for (_, (count, width, component)) in tunnels {
        let edges = count.saturating_sub(1).checked_mul(width).ok_or_else(|| {
            vec![limit_error(
                circuit,
                Some(component),
                "tunnel analysis edge count overflowed usize",
            )]
        })?;
        metrics.wire_bit_edges = metrics.wire_bit_edges.checked_add(edges).ok_or_else(|| {
            vec![limit_error(
                circuit,
                Some(component),
                "wire-bit analysis edge count overflowed usize",
            )]
        })?;
    }
    for component in &components {
        if component.type_id != SPLITTER {
            continue;
        }
        let edges = component
            .properties
            .get("mapping")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or_default();
        metrics.wire_bit_edges = metrics.wire_bit_edges.checked_add(edges).ok_or_else(|| {
            vec![limit_error(
                circuit,
                Some(component),
                "splitter analysis edge count overflowed usize",
            )]
        })?;
    }
    if metrics.wire_bit_edges > MAX_ANALYSIS_EDGES {
        return Err(vec![limit_error(
            circuit,
            components.last().copied(),
            format!(
                "wire-bit analysis edge count {} exceeds {}",
                metrics.wire_bit_edges, MAX_ANALYSIS_EDGES
            ),
        )]);
    }
    Ok(metrics)
}

fn analyze_local_connectivity(
    circuit: &crate::project::ProjectCircuitV3,
    resolved: &BTreeMap<(String, String), Vec<ResolvedProjectPort>>,
    mut metrics: ConnectivityMetrics,
) -> Result<ConnectivityMetrics, Vec<ProjectDiagnostic>> {
    let mut unions = UnionFind::default();
    let mut directions = BTreeMap::new();
    for component in &circuit.components {
        for port in resolved
            .get(&(circuit.id.clone(), component.id.clone()))
            .into_iter()
            .flatten()
        {
            for bit in 0..port.shape.width() {
                let node = bit_node(&component.id, &port.id, bit);
                unions.insert(node.clone());
                directions.insert(node, port.direction);
            }
        }
    }

    let mut wire_nodes = Vec::new();
    let mut wires = circuit.wires.iter().collect::<Vec<_>>();
    wires.sort_by(|left, right| left.id.cmp(&right.id));
    for wire in wires {
        let width = resolved_width(resolved, &circuit.id, &wire.endpoint_a).unwrap_or_default();
        for bit in 0..width {
            let left = bit_node(&wire.endpoint_a.component_id, &wire.endpoint_a.port_id, bit);
            let right = bit_node(&wire.endpoint_b.component_id, &wire.endpoint_b.port_id, bit);
            unions.union(&left, &right);
            wire_nodes.push(left);
        }
    }
    union_tunnels(circuit, resolved, &mut unions);
    union_splitters(circuit, &mut unions);

    let mut net_counts = BTreeMap::<BitNode, (usize, usize, usize)>::new();
    for (node, direction) in directions {
        let Some(root) = unions.root(&node) else {
            continue;
        };
        let counts = net_counts.entry(root).or_default();
        match direction {
            PortDirection::Output => counts.0 += 1,
            PortDirection::Input => counts.1 += 1,
            PortDirection::InOut => {}
        }
    }
    for node in wire_nodes {
        if let Some(root) = unions.root(&node) {
            net_counts.entry(root).or_default().2 += 1;
        }
    }

    for (drivers, consumers, wire_bits) in net_counts.values().copied() {
        let connections = drivers.checked_mul(consumers).ok_or_else(|| {
            vec![limit_error(
                circuit,
                None,
                "connection count overflowed usize",
            )]
        })?;
        metrics.generated_connections = metrics
            .generated_connections
            .checked_add(connections)
            .ok_or_else(|| {
                vec![limit_error(
                    circuit,
                    None,
                    "connection count overflowed usize",
                )]
            })?;
        let references = connections.checked_mul(wire_bits).ok_or_else(|| {
            vec![limit_error(
                circuit,
                None,
                "provenance reference count overflowed usize",
            )]
        })?;
        metrics.provenance_references = metrics
            .provenance_references
            .checked_add(references)
            .ok_or_else(|| {
                vec![limit_error(
                    circuit,
                    None,
                    "provenance reference count overflowed usize",
                )]
            })?;
    }
    if metrics.generated_connections > MAX_EXPANDED_CONNECTIONS {
        return Err(vec![connectivity_local_limit(
            circuit,
            format!(
                "generated connection count {} exceeds {}",
                metrics.generated_connections, MAX_EXPANDED_CONNECTIONS
            ),
        )]);
    }
    if metrics.provenance_references > MAX_PROVENANCE_REFERENCES {
        return Err(vec![connectivity_local_limit(
            circuit,
            format!(
                "provenance reference count {} exceeds {}",
                metrics.provenance_references, MAX_PROVENANCE_REFERENCES
            ),
        )]);
    }
    Ok(metrics)
}

fn v3_dependency_postorder(
    active_circuit_id: &str,
    circuits: &BTreeMap<String, &crate::project::ProjectCircuitV3>,
) -> Option<Vec<String>> {
    circuits.get(active_circuit_id)?;
    let mut states = BTreeMap::<String, u8>::new();
    let mut order = Vec::new();
    let mut stack = vec![(active_circuit_id.to_owned(), 0_usize, Vec::<String>::new())];
    states.insert(active_circuit_id.to_owned(), 1);
    while let Some((circuit_id, child_index, children)) = stack.last_mut() {
        if children.is_empty() {
            let circuit = circuits.get(circuit_id)?;
            *children = circuit
                .components
                .iter()
                .filter(|component| component.type_id == MODULE_INSTANCE)
                .filter_map(|component| component.properties.module_id().map(str::to_owned))
                .collect();
            children.sort();
        }
        if let Some(child) = children.get(*child_index).cloned() {
            *child_index += 1;
            match states.get(&child).copied() {
                Some(1) => return None,
                Some(2) => {}
                _ => {
                    states.insert(child.clone(), 1);
                    stack.push((child, 0, Vec::new()));
                }
            }
        } else {
            let (finished, _, _) = stack.pop()?;
            states.insert(finished.clone(), 2);
            order.push(finished);
        }
    }
    Some(order)
}

#[allow(clippy::too_many_arguments)]
fn check_expanded_metric(
    active: ConnectivityMetrics,
    metric: ConnectivityMetric,
    limit: usize,
    label: &str,
    active_circuit_id: &str,
    circuits: &BTreeMap<String, &crate::project::ProjectCircuitV3>,
    expanded: &BTreeMap<String, ConnectivityMetrics>,
) -> Result<(), Vec<ProjectDiagnostic>> {
    let count = active.value(metric);
    if count <= limit {
        return Ok(());
    }
    let Some(circuit) = circuits.get(active_circuit_id) else {
        return Ok(());
    };
    let instance = circuit
        .components
        .iter()
        .filter(|component| component.type_id == MODULE_INSTANCE)
        .filter_map(|component| {
            let module_id = component.properties.module_id()?;
            Some((expanded.get(module_id)?.value(metric), component))
        })
        .filter(|(contribution, _)| *contribution > 0)
        .max_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| right.1.id.cmp(&left.1.id))
        })
        .map(|(_, component)| component);
    let diagnostic = if let Some(instance) = instance {
        hierarchy_connectivity_limit(
            circuit,
            instance,
            format!("{label} {count} exceeds {limit}"),
        )
    } else {
        connectivity_local_limit(circuit, format!("{label} {count} exceeds {limit}"))
    };
    Err(vec![diagnostic])
}

fn hierarchy_connectivity_limit(
    circuit: &crate::project::ProjectCircuitV3,
    instance: &ProjectComponent,
    message: impl Into<String>,
) -> ProjectDiagnostic {
    v3_error(
        "HIERARCHY_EXPANSION_LIMIT",
        message.into(),
        &circuit.id,
        &[&instance.id],
        &[],
        &[],
    )
}

fn wire_limit_error(
    circuit: &crate::project::ProjectCircuitV3,
    wire: &crate::project::ProjectWire,
    message: impl Into<String>,
) -> ProjectDiagnostic {
    v3_error(
        "HIERARCHY_EXPANSION_LIMIT",
        message.into(),
        &circuit.id,
        &[],
        &[&wire.id],
        &[],
    )
}

fn connectivity_local_limit(
    circuit: &crate::project::ProjectCircuitV3,
    message: impl Into<String>,
) -> ProjectDiagnostic {
    let component_ids = circuit
        .components
        .iter()
        .max_by(|left, right| left.id.cmp(&right.id))
        .map(|component| vec![component.id.as_str()])
        .unwrap_or_default();
    let wire_ids = circuit
        .wires
        .iter()
        .max_by(|left, right| left.id.cmp(&right.id))
        .map(|wire| vec![wire.id.as_str()])
        .unwrap_or_default();
    v3_error(
        "HIERARCHY_EXPANSION_LIMIT",
        message.into(),
        &circuit.id,
        &component_ids,
        &wire_ids,
        &[],
    )
}

fn lower_circuit(
    circuit: &crate::project::ProjectCircuitV3,
    resolved: &BTreeMap<(String, String), Vec<ResolvedProjectPort>>,
    interfaces: &BTreeMap<String, Vec<InterfacePort>>,
) -> Result<CircuitLowering, Vec<ProjectDiagnostic>> {
    let mut components = circuit.components.iter().collect::<Vec<_>>();
    components.sort_by(|left, right| left.id.cmp(&right.id));

    let scalar_component_count = components.iter().try_fold(0_usize, |count, component| {
        let copies = if is_compile_time_helper(&component.type_id) {
            0
        } else if is_scalarized_component(&component.type_id) {
            resolved
                .get(&(circuit.id.clone(), component.id.clone()))
                .and_then(|ports| ports.first())
                .map(|port| usize::from(port.shape.width()))
                .unwrap_or(0)
        } else {
            1
        };
        count.checked_add(copies)
    });
    let Some(scalar_component_count) = scalar_component_count else {
        return Err(vec![limit_error(
            circuit,
            None,
            "scalar component count overflowed usize",
        )]);
    };
    if scalar_component_count > MAX_EXPANDED_COMPONENTS {
        return Err(vec![limit_error(
            circuit,
            components.last().copied(),
            format!(
                "scalar component count {scalar_component_count} exceeds {MAX_EXPANDED_COMPONENTS}"
            ),
        )]);
    }
    let projection_count = components.iter().try_fold(0_usize, |count, component| {
        resolved
            .get(&(circuit.id.clone(), component.id.clone()))
            .into_iter()
            .flatten()
            .try_fold(count, |count, port| {
                count.checked_add(usize::from(port.shape.width()))
            })
    });
    let Some(projection_count) = projection_count else {
        return Err(vec![limit_error(
            circuit,
            None,
            "projection endpoint count overflowed usize",
        )]);
    };
    if projection_count > MAX_PROJECTION_ENDPOINTS {
        return Err(vec![limit_error(
            circuit,
            components.last().copied(),
            format!(
                "projection endpoint count {projection_count} exceeds {MAX_PROJECTION_ENDPOINTS}"
            ),
        )]);
    }

    let mut occupied = components
        .iter()
        .map(|component| component.id.clone())
        .collect::<BTreeSet<_>>();
    let mut scalar_components = Vec::with_capacity(scalar_component_count);
    let mut bit_info = BTreeMap::new();
    let mut reassembly = ReassemblyMetadata::default();
    let mut provenance = ConnectivityProvenance::default();

    for component in components {
        let ports = resolved
            .get(&(circuit.id.clone(), component.id.clone()))
            .cloned()
            .unwrap_or_default();
        if is_compile_time_helper(&component.type_id) {
            add_helper_bits(circuit, component, &ports, &mut bit_info, &mut reassembly);
            continue;
        }
        if component.type_id == MODULE_INSTANCE {
            let interface = component
                .properties
                .module_id()
                .and_then(|module_id| interfaces.get(module_id));
            scalar_components.push(component.clone());
            let scalar_ref =
                QualifiedComponentRef::new(&circuit.id, [] as [&str; 0], &component.id);
            provenance
                .components
                .insert(scalar_ref.clone(), scalar_ref.clone());
            for port in &ports {
                let scalar_ids = interface
                    .and_then(|ports| ports.iter().find(|candidate| candidate.id == port.id))
                    .map(|port| port.scalar_ids.as_slice())
                    .unwrap_or(&[]);
                add_port_bits(
                    circuit,
                    component,
                    port,
                    (0..port.shape.width()).map(|bit| {
                        (
                            Some(component.id.clone()),
                            scalar_ids.get(usize::from(bit)).cloned(),
                        )
                    }),
                    &mut bit_info,
                    &mut reassembly,
                );
            }
            continue;
        }
        if is_scalarized_component(&component.type_id) {
            let Some(port) = ports.first() else {
                continue;
            };
            let interface_port =
                if matches!(component.type_id.as_str(), MODULE_INPUT | MODULE_OUTPUT) {
                    interfaces.get(&circuit.id).and_then(|ports| {
                        ports
                            .iter()
                            .find(|candidate| candidate.boundary_component_id == component.id)
                    })
                } else {
                    None
                };
            let mut scalar_bits = Vec::new();
            for bit in 0..port.shape.width() {
                let id = allocate_id(&format!("{}#bit{bit}", component.id), &mut occupied);
                let properties = scalar_properties(component, bit, interface_port)?;
                scalar_components.push(ProjectComponent {
                    id: id.clone(),
                    type_id: component.type_id.clone(),
                    properties,
                });
                let scalar_ref = QualifiedComponentRef::new(&circuit.id, [] as [&str; 0], &id);
                let original_ref =
                    QualifiedComponentRef::new(&circuit.id, [] as [&str; 0], &component.id);
                provenance.components.insert(scalar_ref, original_ref);
                scalar_bits.push((Some(id), Some(port.id.clone())));
            }
            add_port_bits(
                circuit,
                component,
                port,
                scalar_bits,
                &mut bit_info,
                &mut reassembly,
            );
            continue;
        }

        scalar_components.push(component.clone());
        let scalar_ref = QualifiedComponentRef::new(&circuit.id, [] as [&str; 0], &component.id);
        provenance
            .components
            .insert(scalar_ref.clone(), scalar_ref.clone());
        for port in &ports {
            add_port_bits(
                circuit,
                component,
                port,
                [(Some(component.id.clone()), Some(port.id.clone()))],
                &mut bit_info,
                &mut reassembly,
            );
        }
    }

    let mut unions = UnionFind::default();
    for node in bit_info.keys() {
        unions.insert(node.clone());
    }
    let mut wire_bits = Vec::new();
    let mut wires = circuit.wires.iter().collect::<Vec<_>>();
    wires.sort_by(|left, right| left.id.cmp(&right.id));
    for wire in wires {
        let width = resolved_width(resolved, &circuit.id, &wire.endpoint_a).unwrap_or(0);
        for bit in 0..width {
            let left = bit_node(&wire.endpoint_a.component_id, &wire.endpoint_a.port_id, bit);
            let right = bit_node(&wire.endpoint_b.component_id, &wire.endpoint_b.port_id, bit);
            unions.union(&left, &right);
            wire_bits.push((
                left,
                QualifiedWireBitRef::new(&circuit.id, [] as [&str; 0], &wire.id, bit),
            ));
        }
    }
    union_tunnels(circuit, resolved, &mut unions);
    union_splitters(circuit, &mut unions);

    let mut nets: BTreeMap<BitNode, NetPlan> = BTreeMap::new();
    for (node, info) in &bit_info {
        let Some(root) = unions.root(node) else {
            continue;
        };
        let net = nets.entry(root).or_default();
        let Some(scalar_component_id) = &info.scalar_component_id else {
            continue;
        };
        let Some(scalar_port_id) = &info.scalar_port_id else {
            continue;
        };
        match info.direction {
            PortDirection::Output => {
                net.drivers
                    .insert((scalar_component_id.clone(), scalar_port_id.clone()));
            }
            PortDirection::Input => {
                net.consumers
                    .insert((scalar_component_id.clone(), scalar_port_id.clone()));
            }
            PortDirection::InOut => {}
        }
    }
    for (node, wire_bit_ref) in wire_bits {
        provenance
            .wire_bits
            .entry(wire_bit_ref.clone())
            .or_default();
        if let Some(root) = unions.root(&node) {
            let net = nets.entry(root).or_default();
            net.wires.insert(QualifiedConnectionRef::new(
                &wire_bit_ref.circuit_id,
                wire_bit_ref.instance_path.iter().cloned(),
                &wire_bit_ref.wire_id,
            ));
            net.wire_bits.insert(wire_bit_ref);
        }
    }

    let net_ids = nets
        .iter()
        .enumerate()
        .map(|(index, (root, net))| {
            let net_ref =
                QualifiedNetRef::new(&circuit.id, [] as [&str; 0], format!("v3-net-{index:05}"));
            let scalar_drivers = net
                .drivers
                .iter()
                .map(|(component_id, port_id)| {
                    QualifiedPortRef::new(&circuit.id, [] as [&str; 0], component_id, port_id)
                })
                .collect();
            let scalar_consumers = net
                .consumers
                .iter()
                .map(|(component_id, port_id)| {
                    QualifiedPortRef::new(&circuit.id, [] as [&str; 0], component_id, port_id)
                })
                .collect();
            reassembly.nets.insert(
                net_ref.clone(),
                ReassemblyNet {
                    scalar_drivers,
                    scalar_consumers,
                    ..ReassemblyNet::default()
                },
            );
            (root.clone(), net_ref)
        })
        .collect::<BTreeMap<_, _>>();
    for (logical, bits) in &mut reassembly.ports {
        for (bit_index, bit) in bits.iter_mut().enumerate() {
            let node = bit_node(&logical.component_id, &logical.port_id, bit_index as u8);
            bit.scalar_net = unions
                .root(&node)
                .and_then(|root| net_ids.get(&root).cloned());
        }
    }

    let connection_count = nets.values().try_fold(0_usize, |count, net| {
        net.drivers
            .len()
            .checked_mul(net.consumers.len())
            .and_then(|additional| count.checked_add(additional))
    });
    let Some(connection_count) = connection_count else {
        return Err(vec![limit_error(
            circuit,
            None,
            "scalar connection count overflowed usize",
        )]);
    };
    if connection_count > MAX_EXPANDED_CONNECTIONS {
        let mut cumulative = 0_usize;
        let growth_net = nets.iter().find(|(_, net)| {
            let additional = net.drivers.len() * net.consumers.len();
            cumulative += additional;
            cumulative > MAX_EXPANDED_CONNECTIONS
        });
        let component_ids = growth_net
            .and_then(|(root, _)| {
                circuit
                    .components
                    .iter()
                    .find(|component| component.id == root.component_id)
            })
            .map(|component| vec![component.id.as_str()])
            .unwrap_or_default();
        let wire_ids = growth_net
            .map(|(_, net)| {
                net.wires
                    .iter()
                    .map(|wire| wire.connection_id.as_str())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        return Err(vec![v3_error(
            "HIERARCHY_EXPANSION_LIMIT",
            format!(
                "scalar connection count {connection_count} exceeds {MAX_EXPANDED_CONNECTIONS}"
            ),
            &circuit.id,
            &component_ids,
            &wire_ids,
            &[],
        )]);
    }
    let mut scalar_connections = Vec::with_capacity(connection_count);
    for net in nets.values() {
        for driver in &net.drivers {
            for consumer in &net.consumers {
                let id = format!("v3-wire-{:05}", scalar_connections.len());
                scalar_connections.push(ProjectConnection {
                    id: id.clone(),
                    source_component_id: driver.0.clone(),
                    source_port_id: driver.1.clone(),
                    target_component_id: consumer.0.clone(),
                    target_port_id: consumer.1.clone(),
                });
                provenance.connections.insert(
                    QualifiedConnectionRef::new(&circuit.id, [] as [&str; 0], &id),
                    net.wires.iter().cloned().collect(),
                );
                let generated_ref = QualifiedConnectionRef::new(&circuit.id, [] as [&str; 0], id);
                for wire_bit in &net.wire_bits {
                    provenance
                        .wire_bits
                        .entry(wire_bit.clone())
                        .or_default()
                        .push(generated_ref.clone());
                }
            }
        }
    }
    scalar_components.sort_by(|left, right| left.id.cmp(&right.id));

    Ok(CircuitLowering {
        circuit: ProjectCircuit {
            id: circuit.id.clone(),
            name: circuit.name.clone(),
            kind: circuit.kind,
            components: scalar_components,
            connections: scalar_connections,
        },
        reassembly,
        provenance,
    })
}

fn add_helper_bits(
    circuit: &crate::project::ProjectCircuitV3,
    component: &ProjectComponent,
    ports: &[ResolvedProjectPort],
    bit_info: &mut BTreeMap<BitNode, BitInfo>,
    reassembly: &mut ReassemblyMetadata,
) {
    for port in ports {
        add_port_bits(
            circuit,
            component,
            port,
            (0..port.shape.width()).map(|_| (None, None)),
            bit_info,
            reassembly,
        );
    }
}

fn add_port_bits(
    circuit: &crate::project::ProjectCircuitV3,
    component: &ProjectComponent,
    port: &ResolvedProjectPort,
    scalar_bits: impl IntoIterator<Item = (Option<String>, Option<String>)>,
    bit_info: &mut BTreeMap<BitNode, BitInfo>,
    reassembly: &mut ReassemblyMetadata,
) {
    let logical = QualifiedPortRef::new(&circuit.id, [] as [&str; 0], &component.id, &port.id);
    let bits = scalar_bits
        .into_iter()
        .enumerate()
        .map(|(bit, (component_id, port_id))| {
            bit_info.insert(
                bit_node(&component.id, &port.id, bit as u8),
                BitInfo {
                    direction: port.direction,
                    scalar_component_id: component_id.clone(),
                    scalar_port_id: port_id.clone(),
                },
            );
            ScalarBitEndpoint {
                scalar_port: component_id.zip(port_id).map(|(component_id, port_id)| {
                    QualifiedPortRef::new(&circuit.id, [] as [&str; 0], component_id, port_id)
                }),
                scalar_net: None,
                flat_endpoints: Vec::new(),
            }
        })
        .collect();
    reassembly.ports.insert(logical, bits);
}

fn scalar_properties(
    component: &ProjectComponent,
    bit: u8,
    interface_port: Option<&InterfacePort>,
) -> Result<ProjectProperties, Vec<ProjectDiagnostic>> {
    let Value::Object(mut properties) =
        serde_json::to_value(&component.properties).unwrap_or(Value::Null)
    else {
        return Err(vec![v3_error(
            "INVALID_PROPERTY",
            format!("component '{}' properties are not an object", component.id),
            "",
            &[&component.id],
            &[],
            &[],
        )]);
    };
    properties.remove("width");
    for key in ["value", "previewValue"] {
        if let Some(value) = properties.get_mut(key)
            && let Some(word) = value.as_str()
            && let Some(symbol) = word.chars().rev().nth(usize::from(bit))
        {
            *value = Value::String(symbol.to_string());
        }
    }
    if let Some(port) = interface_port
        && let Some(scalar_id) = port.scalar_ids.get(usize::from(bit))
    {
        properties.insert("portId".into(), Value::String(scalar_id.clone()));
    }
    ProjectProperties::from_value(Value::Object(properties)).map_err(|error| {
        vec![v3_error(
            "INVALID_PROPERTY",
            format!("component '{}': {error}", component.id),
            "",
            &[&component.id],
            &[],
            &[],
        )]
    })
}

fn union_tunnels(
    circuit: &crate::project::ProjectCircuitV3,
    resolved: &BTreeMap<(String, String), Vec<ResolvedProjectPort>>,
    unions: &mut UnionFind,
) {
    let mut groups: BTreeMap<&str, Vec<&ProjectComponent>> = BTreeMap::new();
    for component in &circuit.components {
        if component.type_id == TUNNEL
            && let Some(label) = component.properties.label()
        {
            groups.entry(label).or_default().push(component);
        }
    }
    for tunnels in groups.values_mut() {
        tunnels.sort_by(|left, right| left.id.cmp(&right.id));
        let Some(first) = tunnels.first() else {
            continue;
        };
        let width = resolved
            .get(&(circuit.id.clone(), first.id.clone()))
            .and_then(|ports| ports.first())
            .map(|port| port.shape.width())
            .unwrap_or(0);
        for tunnel in tunnels.iter().skip(1) {
            for bit in 0..width {
                unions.union(
                    &bit_node(&first.id, "net", bit),
                    &bit_node(&tunnel.id, "net", bit),
                );
            }
        }
    }
}

fn union_splitters(circuit: &crate::project::ProjectCircuitV3, unions: &mut UnionFind) {
    for component in &circuit.components {
        if component.type_id != SPLITTER {
            continue;
        }
        let Some(mapping) = component
            .properties
            .get("mapping")
            .and_then(Value::as_array)
        else {
            continue;
        };
        let mut local_indexes = BTreeMap::<u64, u8>::new();
        for (trunk_bit, branch) in mapping.iter().enumerate() {
            let Some(branch) = branch.as_u64() else {
                continue;
            };
            let local = local_indexes.entry(branch).or_default();
            unions.union(
                &bit_node(&component.id, "trunk", trunk_bit as u8),
                &bit_node(&component.id, &format!("branch{branch}"), *local),
            );
            *local += 1;
        }
    }
}

fn expand_reassembly(
    lowered: &LoweredProjectV3,
    compiled: &CompiledProject,
    active_circuit_id: &str,
) -> ReassemblyMetadata {
    let circuits: BTreeMap<_, _> = lowered
        .project
        .circuits
        .iter()
        .map(|circuit| (circuit.id.as_str(), circuit))
        .collect();
    let mut result = ReassemblyMetadata::default();
    let mut stack = vec![(
        active_circuit_id.to_owned(),
        Vec::<String>::new(),
        None::<(String, Vec<String>, String)>,
    )];
    while let Some((circuit_id, path, parent_instance)) = stack.pop() {
        let Some(circuit) = circuits.get(circuit_id.as_str()) else {
            continue;
        };
        for (net_ref, net) in lowered
            .reassembly
            .nets
            .iter()
            .filter(|(net_ref, _)| net_ref.circuit_id == circuit_id)
        {
            let qualified_net =
                QualifiedNetRef::new(&net_ref.circuit_id, path.iter().cloned(), &net_ref.net_id);
            let scalar_drivers = qualify_ports(&net.scalar_drivers, &path);
            let scalar_consumers = qualify_ports(&net.scalar_consumers, &path);
            let flat_drivers = scalar_drivers
                .iter()
                .flat_map(|port| {
                    flat_endpoints_with_boundary_alias(
                        port,
                        circuit,
                        parent_instance.as_ref(),
                        compiled,
                    )
                })
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let flat_consumers = scalar_consumers
                .iter()
                .flat_map(|port| {
                    flat_endpoints_with_boundary_alias(
                        port,
                        circuit,
                        parent_instance.as_ref(),
                        compiled,
                    )
                })
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            result.nets.insert(
                qualified_net,
                ReassemblyNet {
                    scalar_drivers,
                    scalar_consumers,
                    flat_drivers,
                    flat_consumers,
                },
            );
        }
        for (logical, bits) in lowered
            .reassembly
            .ports
            .iter()
            .filter(|(logical, _)| logical.circuit_id == circuit_id)
        {
            let qualified_logical = QualifiedPortRef::new(
                &logical.circuit_id,
                path.iter().cloned(),
                &logical.component_id,
                &logical.port_id,
            );
            let qualified_bits = bits
                .iter()
                .map(|bit| {
                    let scalar_port = bit.scalar_port.as_ref().map(|port| {
                        QualifiedPortRef::new(
                            &port.circuit_id,
                            path.iter().cloned(),
                            &port.component_id,
                            &port.port_id,
                        )
                    });
                    let scalar_net = bit.scalar_net.as_ref().map(|net| {
                        QualifiedNetRef::new(&net.circuit_id, path.iter().cloned(), &net.net_id)
                    });
                    let mut flat_endpoints = scalar_port
                        .as_ref()
                        .map(|port| {
                            flat_endpoints_with_boundary_alias(
                                port,
                                circuit,
                                parent_instance.as_ref(),
                                compiled,
                            )
                        })
                        .unwrap_or_default();
                    if flat_endpoints.is_empty()
                        && let Some(net_ref) = &scalar_net
                        && let Some(net) = result.nets.get(net_ref)
                    {
                        flat_endpoints = if net.flat_consumers.is_empty() {
                            net.flat_drivers.clone()
                        } else {
                            net.flat_consumers.clone()
                        };
                    }
                    ScalarBitEndpoint {
                        scalar_port,
                        scalar_net,
                        flat_endpoints,
                    }
                })
                .collect();
            result.ports.insert(qualified_logical, qualified_bits);
        }
        for component in circuit.components.iter().rev() {
            if component.type_id == MODULE_INSTANCE
                && let Some(module_id) = component.properties.module_id()
            {
                let mut child_path = path.clone();
                child_path.push(component.id.clone());
                stack.push((
                    module_id.to_owned(),
                    child_path,
                    Some((circuit_id.clone(), path.clone(), component.id.clone())),
                ));
            }
        }
    }
    result
}

fn qualify_ports(ports: &[QualifiedPortRef], path: &[String]) -> Vec<QualifiedPortRef> {
    ports
        .iter()
        .map(|port| {
            QualifiedPortRef::new(
                &port.circuit_id,
                path.iter().cloned(),
                &port.component_id,
                &port.port_id,
            )
        })
        .collect()
}

fn flat_endpoints_with_boundary_alias(
    port: &QualifiedPortRef,
    circuit: &ProjectCircuit,
    parent_instance: Option<&(String, Vec<String>, String)>,
    compiled: &CompiledProject,
) -> Vec<FlatPortRef> {
    let mut endpoints = flat_endpoints_for(port, compiled);
    if endpoints.is_empty()
        && let Some((parent_circuit, parent_path, instance_id)) = parent_instance
        && let Some(boundary) = circuit
            .components
            .iter()
            .find(|component| component.id == port.component_id)
        && matches!(boundary.type_id.as_str(), MODULE_INPUT | MODULE_OUTPUT)
        && let Some(interface_port_id) = boundary.properties.port_id()
    {
        let instance_port = QualifiedPortRef::new(
            parent_circuit,
            parent_path.iter().cloned(),
            instance_id,
            interface_port_id,
        );
        endpoints = flat_endpoints_for(&instance_port, compiled);
    }
    endpoints
}

fn flat_endpoints_for(port: &QualifiedPortRef, compiled: &CompiledProject) -> Vec<FlatPortRef> {
    let flat_id = flat_component_id(&port.instance_path, &port.component_id);
    if compiled
        .circuit
        .components
        .iter()
        .any(|component| component.id == flat_id)
    {
        return vec![FlatPortRef {
            component_id: flat_id,
            port_id: port.port_id.clone(),
        }];
    }
    if let Some(entry) = compiled
        .projection
        .ports
        .get(port)
        .or_else(|| compiled.projection.boundaries.get(port))
    {
        let mut endpoints = entry
            .endpoints
            .iter()
            .chain(&entry.drivers)
            .chain(&entry.direct_drivers)
            .cloned()
            .collect::<Vec<_>>();
        endpoints.sort();
        endpoints.dedup();
        return endpoints;
    }
    Vec::new()
}

fn compose_wire_provenance(
    provenance: &ConnectivityProvenance,
    compiled: &CompiledProject,
) -> BTreeMap<String, Vec<QualifiedConnectionRef>> {
    let mut result = BTreeMap::new();
    for (flat_connection, scalar_refs) in &compiled.provenance.connections {
        let mut wires = BTreeSet::new();
        for scalar_ref in scalar_refs {
            let key = QualifiedConnectionRef::new(
                &scalar_ref.circuit_id,
                [] as [&str; 0],
                &scalar_ref.connection_id,
            );
            if let Some(source_wires) = provenance.connections.get(&key) {
                wires.extend(source_wires.iter().map(|wire| {
                    QualifiedConnectionRef::new(
                        &wire.circuit_id,
                        scalar_ref.instance_path.iter().cloned(),
                        &wire.connection_id,
                    )
                }));
            }
        }
        result.insert(flat_connection.clone(), wires.into_iter().collect());
    }
    result
}

fn compose_reverse_wire_provenance(
    lowered: &LoweredProjectV3,
    compiled: &CompiledProject,
    active_circuit_id: &str,
) -> BTreeMap<QualifiedWireBitRef, Vec<String>> {
    let mut flat_connections_by_scalar = BTreeMap::<QualifiedConnectionRef, Vec<String>>::new();
    for (flat_connection_id, scalar_connections) in &compiled.provenance.connections {
        for scalar_connection in scalar_connections {
            flat_connections_by_scalar
                .entry(scalar_connection.clone())
                .or_default()
                .push(flat_connection_id.clone());
        }
    }
    for flat_connections in flat_connections_by_scalar.values_mut() {
        flat_connections.sort();
        flat_connections.dedup();
    }

    let mut result = BTreeMap::new();
    for (circuit_id, path) in active_circuit_occurrences(&lowered.project, active_circuit_id) {
        for (wire_bit, scalar_connections) in lowered
            .provenance
            .wire_bits
            .iter()
            .filter(|(wire_bit, _)| wire_bit.circuit_id == circuit_id)
        {
            let qualified_wire_bit = QualifiedWireBitRef::new(
                &wire_bit.circuit_id,
                path.iter().cloned(),
                &wire_bit.wire_id,
                wire_bit.bit_index,
            );
            let mut flat_connections = BTreeSet::new();
            for scalar_connection in scalar_connections {
                let qualified_scalar = QualifiedConnectionRef::new(
                    &scalar_connection.circuit_id,
                    path.iter().cloned(),
                    &scalar_connection.connection_id,
                );
                if let Some(ids) = flat_connections_by_scalar.get(&qualified_scalar) {
                    flat_connections.extend(ids.iter().cloned());
                }
            }
            result.insert(qualified_wire_bit, flat_connections.into_iter().collect());
        }
    }
    result
}

fn active_circuit_occurrences(
    project: &ProjectDocument,
    active_circuit_id: &str,
) -> Vec<(String, Vec<String>)> {
    let circuits = project
        .circuits
        .iter()
        .map(|circuit| (circuit.id.as_str(), circuit))
        .collect::<BTreeMap<_, _>>();
    let mut occurrences = Vec::new();
    let mut stack = vec![(active_circuit_id.to_owned(), Vec::<String>::new())];
    while let Some((circuit_id, path)) = stack.pop() {
        let Some(circuit) = circuits.get(circuit_id.as_str()) else {
            continue;
        };
        occurrences.push((circuit_id.clone(), path.clone()));
        for component in circuit.components.iter().rev() {
            if component.type_id == MODULE_INSTANCE
                && let Some(module_id) = component.properties.module_id()
            {
                let mut child_path = path.clone();
                child_path.push(component.id.clone());
                stack.push((module_id.to_owned(), child_path));
            }
        }
    }
    occurrences
}

fn remap_diagnostics(
    diagnostics: &[ProjectDiagnostic],
    provenance: &ConnectivityProvenance,
    reassembly: &ReassemblyMetadata,
) -> Vec<ProjectDiagnostic> {
    let port_origins = reassembly
        .ports
        .iter()
        .flat_map(|(logical, bits)| {
            bits.iter().filter_map(|bit| {
                bit.scalar_port
                    .clone()
                    .map(|scalar| (scalar, logical.clone()))
            })
        })
        .collect::<BTreeMap<_, _>>();
    diagnostics
        .iter()
        .map(|diagnostic| {
            let component_refs = diagnostic
                .component_refs
                .iter()
                .map(|reference| {
                    let key = QualifiedComponentRef::new(
                        &reference.circuit_id,
                        [] as [&str; 0],
                        &reference.component_id,
                    );
                    provenance
                        .components
                        .get(&key)
                        .map(|origin| {
                            QualifiedComponentRef::new(
                                &origin.circuit_id,
                                reference.instance_path.iter().cloned(),
                                &origin.component_id,
                            )
                        })
                        .unwrap_or_else(|| reference.clone())
                })
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let port_refs = diagnostic
                .port_refs
                .iter()
                .map(|reference| {
                    let key = QualifiedPortRef::new(
                        &reference.circuit_id,
                        [] as [&str; 0],
                        &reference.component_id,
                        &reference.port_id,
                    );
                    port_origins
                        .get(&key)
                        .map(|origin| {
                            QualifiedPortRef::new(
                                &origin.circuit_id,
                                reference.instance_path.iter().cloned(),
                                &origin.component_id,
                                &origin.port_id,
                            )
                        })
                        .unwrap_or_else(|| reference.clone())
                })
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let connection_refs = diagnostic
                .connection_refs
                .iter()
                .flat_map(|reference| {
                    let key = QualifiedConnectionRef::new(
                        &reference.circuit_id,
                        [] as [&str; 0],
                        &reference.connection_id,
                    );
                    provenance
                        .connections
                        .get(&key)
                        .cloned()
                        .unwrap_or_else(|| vec![reference.clone()])
                })
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let primary_location = port_refs
                .first()
                .cloned()
                .map(ProjectLocation::Port)
                .or_else(|| {
                    component_refs
                        .first()
                        .cloned()
                        .map(ProjectLocation::Component)
                })
                .or_else(|| {
                    connection_refs
                        .first()
                        .cloned()
                        .map(ProjectLocation::Connection)
                });
            ProjectDiagnostic {
                code: diagnostic.code.clone(),
                severity: diagnostic.severity,
                message: diagnostic.message.clone(),
                primary_location,
                component_refs,
                connection_refs,
                port_refs,
            }
        })
        .collect()
}

fn resolved_width(
    resolved: &BTreeMap<(String, String), Vec<ResolvedProjectPort>>,
    circuit_id: &str,
    endpoint: &crate::project::WireEndpoint,
) -> Option<u8> {
    resolved
        .get(&(circuit_id.to_owned(), endpoint.component_id.clone()))?
        .iter()
        .find(|port| port.id == endpoint.port_id)
        .map(|port| port.shape.width())
}

fn is_compile_time_helper(type_id: &str) -> bool {
    matches!(type_id, JUNCTION | TUNNEL | SPLITTER)
}

fn is_scalarized_component(type_id: &str) -> bool {
    matches!(
        type_id,
        "source.trit_input" | "source.constant" | "sink.probe" | MODULE_INPUT | MODULE_OUTPUT
    )
}

fn bit_node(component_id: &str, port_id: &str, bit: u8) -> BitNode {
    BitNode {
        component_id: component_id.to_owned(),
        port_id: port_id.to_owned(),
        bit,
    }
}

fn allocate_id(base: &str, occupied: &mut BTreeSet<String>) -> String {
    let mut candidate = base.to_owned();
    loop {
        if occupied.insert(candidate.clone()) {
            return candidate;
        }
        candidate.push('#');
    }
}

fn flat_component_id(path: &[String], component_id: &str) -> String {
    path.iter()
        .map(|segment| escape_segment(segment))
        .chain(std::iter::once(escape_segment(component_id)))
        .collect::<Vec<_>>()
        .join("/")
}

fn escape_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

fn count_ids<'a>(ids: impl IntoIterator<Item = &'a str>) -> BTreeMap<String, usize> {
    ids.into_iter().fold(BTreeMap::new(), |mut counts, id| {
        *counts.entry(id.to_owned()).or_default() += 1;
        counts
    })
}

fn has_errors(diagnostics: &[ProjectDiagnostic]) -> bool {
    diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error)
}

fn limit_error(
    circuit: &crate::project::ProjectCircuitV3,
    component: Option<&ProjectComponent>,
    message: impl Into<String>,
) -> ProjectDiagnostic {
    let component_ids = component
        .map(|component| vec![component.id.as_str()])
        .unwrap_or_default();
    v3_error(
        "HIERARCHY_EXPANSION_LIMIT",
        message.into(),
        &circuit.id,
        &component_ids,
        &[],
        &[],
    )
}

fn v3_error(
    code: &str,
    message: String,
    circuit_id: &str,
    component_ids: &[&str],
    wire_ids: &[&str],
    ports: &[(&str, &str)],
) -> ProjectDiagnostic {
    let component_refs = component_ids
        .iter()
        .map(|component_id| QualifiedComponentRef::new(circuit_id, [] as [&str; 0], *component_id))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let connection_refs = wire_ids
        .iter()
        .map(|wire_id| QualifiedConnectionRef::new(circuit_id, [] as [&str; 0], *wire_id))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let port_refs = ports
        .iter()
        .map(|(component_id, port_id)| {
            QualifiedPortRef::new(circuit_id, [] as [&str; 0], *component_id, *port_id)
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let primary_location = port_refs
        .first()
        .cloned()
        .map(ProjectLocation::Port)
        .or_else(|| {
            component_refs
                .first()
                .cloned()
                .map(ProjectLocation::Component)
        })
        .or_else(|| {
            connection_refs
                .first()
                .cloned()
                .map(ProjectLocation::Connection)
        });
    ProjectDiagnostic {
        code: code.into(),
        severity: Severity::Error,
        message,
        primary_location,
        component_refs,
        connection_refs,
        port_refs,
    }
}
