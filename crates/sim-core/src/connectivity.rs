use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::catalog::PortDirection;
use crate::diagnostic::Severity;
use crate::hierarchy::{
    CompiledProject, FlatPortRef, MAX_EXPANDED_COMPONENTS, MAX_EXPANDED_CONNECTIONS,
    MAX_PROJECTION_ENDPOINTS, compile_project,
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
    pub flat_endpoints: Vec<FlatPortRef>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReassemblyMetadata {
    pub ports: BTreeMap<QualifiedPortRef, Vec<ScalarBitEndpoint>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityProvenance {
    pub components: BTreeMap<QualifiedComponentRef, QualifiedComponentRef>,
    pub connections: BTreeMap<QualifiedConnectionRef, Vec<QualifiedConnectionRef>>,
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

    let mut lowered_circuits = Vec::with_capacity(unique_circuits.len());
    let mut reassembly = ReassemblyMetadata::default();
    let mut provenance = ConnectivityProvenance::default();
    for circuit in unique_circuits.values() {
        let lowered = lower_circuit(circuit, &resolved_ports, &interfaces)?;
        lowered_circuits.push(lowered.circuit);
        reassembly.ports.extend(lowered.reassembly.ports);
        provenance.components.extend(lowered.provenance.components);
        provenance
            .connections
            .extend(lowered.provenance.connections);
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
    let lowered = lower_project_v3(project)?;
    let validated = validate_project(lowered.project.clone())
        .map_err(|errors| remap_diagnostics(&errors, &lowered.provenance, &lowered.reassembly))?;
    let compiled = compile_project(&validated, active_circuit_id)
        .map_err(|errors| remap_diagnostics(&errors, &lowered.provenance, &lowered.reassembly))?;
    let reassembly = expand_reassembly(&lowered, &compiled, active_circuit_id);
    let wire_provenance = compose_wire_provenance(&lowered.provenance, &compiled);
    Ok(CompiledProjectV3 {
        lowered,
        compiled,
        reassembly,
        wire_provenance,
    })
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
                QualifiedConnectionRef::new(&circuit.id, [] as [&str; 0], &wire.id),
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
    for (node, wire_ref) in wire_bits {
        if let Some(root) = unions.root(&node) {
            nets.entry(root).or_default().wires.insert(wire_ref);
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
                    QualifiedConnectionRef::new(&circuit.id, [] as [&str; 0], id),
                    net.wires.iter().cloned().collect(),
                );
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
                    let mut flat_endpoints = scalar_port
                        .as_ref()
                        .map(|port| flat_endpoints_for(port, compiled))
                        .unwrap_or_default();
                    if flat_endpoints.is_empty()
                        && let (Some(port), Some((parent_circuit, parent_path, instance_id))) =
                            (&scalar_port, &parent_instance)
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
                        flat_endpoints = flat_endpoints_for(&instance_port, compiled);
                    }
                    ScalarBitEndpoint {
                        scalar_port,
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
