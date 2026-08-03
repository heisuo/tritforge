use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::catalog::{ComponentKind, ComponentProperties, PortDirection};
use crate::circuit::{CircuitDefinition, ComponentInstance, Connection};
use crate::diagnostic::Severity;
use crate::project::{
    ProjectCircuit, ProjectComponent, ProjectDiagnostic, ProjectLocation, QualifiedComponentRef,
    QualifiedConnectionRef, QualifiedPortRef,
};
use crate::project_validation::{ModulePort, ValidatedProject};

pub const MAX_HIERARCHY_DEPTH: usize = 32;
pub const MAX_EXPANDED_COMPONENTS: usize = 10_000;
pub const MAX_EXPANDED_CONNECTIONS: usize = 50_000;
pub const MAX_PROJECTION_ENDPOINTS: usize = 100_000;

const MODULE_INPUT: &str = "project.module_input";
const MODULE_OUTPUT: &str = "project.module_output";
const MODULE_INSTANCE: &str = "project.module_instance";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlatPortRef {
    pub component_id: String,
    pub port_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionEntry {
    pub direction: PortDirection,
    pub endpoints: Vec<FlatPortRef>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionMap {
    pub ports: BTreeMap<QualifiedPortRef, ProjectionEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceMap {
    pub components: BTreeMap<String, QualifiedComponentRef>,
    pub connections: BTreeMap<String, Vec<QualifiedConnectionRef>>,
    pub source_copies: BTreeMap<QualifiedComponentRef, Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledProject {
    pub circuit: CircuitDefinition,
    pub projection: ProjectionMap,
    pub provenance: ProvenanceMap,
}

pub fn compile_project(
    project: &ValidatedProject,
    active_circuit_id: &str,
) -> Result<CompiledProject, Vec<ProjectDiagnostic>> {
    let Some(active) = project
        .project
        .circuits
        .iter()
        .find(|circuit| circuit.id == active_circuit_id)
    else {
        return Err(vec![project_error(
            "INVALID_ACTIVE_CIRCUIT",
            format!("active circuit '{active_circuit_id}' does not exist"),
            active_circuit_id,
        )]);
    };

    let counts = analyze_active_circuit(project, &active.id).ok_or_else(|| {
        vec![limit_error(
            active_circuit_id,
            "hierarchy count overflowed usize",
        )]
    })?;
    if counts.depth > MAX_HIERARCHY_DEPTH {
        return Err(vec![limit_error(
            active_circuit_id,
            format!(
                "hierarchy depth {} exceeds {}",
                counts.depth, MAX_HIERARCHY_DEPTH
            ),
        )]);
    }
    if counts.primitive_components > MAX_EXPANDED_COMPONENTS {
        return Err(vec![limit_error(
            active_circuit_id,
            format!(
                "expanded component count {} exceeds {}",
                counts.primitive_components, MAX_EXPANDED_COMPONENTS
            ),
        )]);
    }

    let circuits = project
        .project
        .circuits
        .iter()
        .cloned()
        .map(|circuit| (circuit.id.clone(), circuit))
        .collect();
    let mut builder = HierarchyBuilder {
        project,
        circuits,
        nodes: BTreeMap::new(),
        edges: BTreeMap::new(),
        flat_components: BTreeMap::new(),
        active_ports: Vec::new(),
        provenance: ProvenanceMap::default(),
    };
    builder.expand_circuit(active_circuit_id, &[], true)?;
    builder.finish(active_circuit_id)
}

#[derive(Debug, Clone, Copy)]
struct ExpansionCounts {
    primitive_components: usize,
    graph_nodes: usize,
    graph_edges: usize,
    depth: usize,
}

fn analyze_active_circuit(
    project: &ValidatedProject,
    active_circuit_id: &str,
) -> Option<ExpansionCounts> {
    let order = dependency_postorder(active_circuit_id, &project.dependencies)?;
    let mut nested_counts = BTreeMap::new();
    for circuit_id in order {
        let counts = count_circuit(project, &circuit_id, false, &nested_counts)?;
        nested_counts.insert(circuit_id, counts);
    }
    count_circuit(project, active_circuit_id, true, &nested_counts)
}

fn dependency_postorder(
    active_circuit_id: &str,
    dependencies: &BTreeMap<String, Vec<String>>,
) -> Option<Vec<String>> {
    dependencies.get(active_circuit_id)?;
    let mut visited = BTreeSet::from([active_circuit_id.to_owned()]);
    let mut order = Vec::new();
    let mut stack = vec![(active_circuit_id.to_owned(), 0_usize)];

    while let Some((circuit_id, child_index)) = stack.last_mut() {
        let children = dependencies.get(circuit_id)?.as_slice();
        if let Some(child) = children.get(*child_index).cloned() {
            *child_index += 1;
            if visited.insert(child.clone()) {
                stack.push((child, 0));
            }
        } else {
            let (finished, _) = stack.pop()?;
            order.push(finished);
        }
    }

    Some(order)
}

fn count_circuit(
    project: &ValidatedProject,
    circuit_id: &str,
    is_root: bool,
    nested_counts: &BTreeMap<String, ExpansionCounts>,
) -> Option<ExpansionCounts> {
    let circuit = project
        .project
        .circuits
        .iter()
        .find(|circuit| circuit.id == circuit_id)?;
    let mut counts = ExpansionCounts {
        primitive_components: 0,
        graph_nodes: 0,
        graph_edges: circuit.connections.len(),
        depth: 1,
    };

    for component in &circuit.components {
        match component.type_id.as_str() {
            MODULE_INPUT | MODULE_OUTPUT => {
                counts.graph_nodes = counts.graph_nodes.checked_add(1)?;
                if is_root {
                    counts.primitive_components = counts.primitive_components.checked_add(1)?;
                }
            }
            MODULE_INSTANCE => {
                let module_id = component.properties.module_id()?;
                let ports = project.interfaces.get(module_id)?.len();
                let child = *nested_counts.get(module_id)?;
                counts.graph_nodes = counts
                    .graph_nodes
                    .checked_add(ports)?
                    .checked_add(child.graph_nodes)?;
                counts.graph_edges = counts
                    .graph_edges
                    .checked_add(ports)?
                    .checked_add(child.graph_edges)?;
                counts.primitive_components = counts
                    .primitive_components
                    .checked_add(child.primitive_components)?;
                counts.depth = counts.depth.max(child.depth.checked_add(1)?);
            }
            type_id => {
                let kind = ComponentKind::from_type_id(type_id)?;
                counts.graph_nodes = counts
                    .graph_nodes
                    .checked_add(kind.port_descriptors().len())?;
                counts.primitive_components = counts.primitive_components.checked_add(1)?;
            }
        }
    }

    Some(counts)
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct NodeKey {
    circuit_id: String,
    instance_path: Vec<String>,
    component_id: String,
    port_id: String,
}

impl NodeKey {
    fn new(circuit_id: &str, path: &[String], component_id: &str, port_id: &str) -> Self {
        Self {
            circuit_id: circuit_id.to_owned(),
            instance_path: path.to_vec(),
            component_id: component_id.to_owned(),
            port_id: port_id.to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum NodeRole {
    Virtual,
    PrimitiveInput(FlatPortRef),
    PrimitiveOutput(FlatPortRef),
}

struct ActivePort {
    reference: QualifiedPortRef,
    node: NodeKey,
    direction: PortDirection,
}

struct HierarchyBuilder<'a> {
    project: &'a ValidatedProject,
    circuits: BTreeMap<String, ProjectCircuit>,
    nodes: BTreeMap<NodeKey, NodeRole>,
    edges: BTreeMap<NodeKey, BTreeMap<NodeKey, BTreeSet<QualifiedConnectionRef>>>,
    flat_components: BTreeMap<String, ComponentInstance>,
    active_ports: Vec<ActivePort>,
    provenance: ProvenanceMap,
}

impl HierarchyBuilder<'_> {
    fn expand_circuit(
        &mut self,
        circuit_id: &str,
        path: &[String],
        is_root: bool,
    ) -> Result<(), Vec<ProjectDiagnostic>> {
        let circuit = self
            .circuits
            .get(circuit_id)
            .cloned()
            .expect("validated circuit exists");

        for component in &circuit.components {
            match component.type_id.as_str() {
                MODULE_INPUT => self.add_boundary(&circuit, component, path, is_root, true),
                MODULE_OUTPUT => self.add_boundary(&circuit, component, path, is_root, false),
                MODULE_INSTANCE => {
                    self.add_instance(&circuit, component, path, is_root)?;
                }
                _ => self.add_primitive(&circuit, component, path, is_root),
            }
        }

        for connection in &circuit.connections {
            let source = NodeKey::new(
                circuit_id,
                path,
                &connection.source_component_id,
                &connection.source_port_id,
            );
            let target = NodeKey::new(
                circuit_id,
                path,
                &connection.target_component_id,
                &connection.target_port_id,
            );
            let reference =
                QualifiedConnectionRef::new(circuit_id, path.iter().cloned(), &connection.id);
            self.add_edge(source, target, Some(reference));
        }
        Ok(())
    }

    fn add_boundary(
        &mut self,
        circuit: &ProjectCircuit,
        component: &ProjectComponent,
        path: &[String],
        is_root: bool,
        is_input: bool,
    ) {
        let fixed_port = if is_input { "out" } else { "in" };
        let direction = if is_input {
            PortDirection::Output
        } else {
            PortDirection::Input
        };
        let node = NodeKey::new(&circuit.id, path, &component.id, fixed_port);
        if is_root {
            let flat_id = flat_component_id(path, &component.id);
            let (type_id, properties, role) = if is_input {
                let flat_port = FlatPortRef {
                    component_id: flat_id.clone(),
                    port_id: "out".into(),
                };
                (
                    "source.trit_input".to_owned(),
                    ComponentProperties {
                        value: component.properties.preview_value(),
                    },
                    NodeRole::PrimitiveOutput(flat_port),
                )
            } else {
                let flat_port = FlatPortRef {
                    component_id: flat_id.clone(),
                    port_id: "in".into(),
                };
                (
                    "sink.probe".to_owned(),
                    ComponentProperties::default(),
                    NodeRole::PrimitiveInput(flat_port),
                )
            };
            self.flat_components.insert(
                flat_id.clone(),
                ComponentInstance {
                    id: flat_id.clone(),
                    type_id,
                    properties,
                },
            );
            let component_ref =
                QualifiedComponentRef::new(&circuit.id, path.iter().cloned(), &component.id);
            self.provenance
                .components
                .insert(flat_id.clone(), component_ref.clone());
            if is_input {
                self.provenance
                    .source_copies
                    .entry(component_ref)
                    .or_default()
                    .push(flat_id);
            }
            self.nodes.insert(node.clone(), role);
        } else {
            self.nodes.insert(node.clone(), NodeRole::Virtual);
        }
        if is_root {
            self.active_ports.push(ActivePort {
                reference: QualifiedPortRef::new(
                    &circuit.id,
                    path.iter().cloned(),
                    &component.id,
                    fixed_port,
                ),
                node,
                direction,
            });
        }
    }

    fn add_primitive(
        &mut self,
        circuit: &ProjectCircuit,
        component: &ProjectComponent,
        path: &[String],
        is_root: bool,
    ) {
        let kind = ComponentKind::from_type_id(&component.type_id)
            .expect("validated primitive component type");
        let flat_id = flat_component_id(path, &component.id);
        self.flat_components.insert(
            flat_id.clone(),
            ComponentInstance {
                id: flat_id.clone(),
                type_id: component.type_id.clone(),
                properties: ComponentProperties {
                    value: component.properties.known_value(),
                },
            },
        );
        let component_ref =
            QualifiedComponentRef::new(&circuit.id, path.iter().cloned(), &component.id);
        self.provenance
            .components
            .insert(flat_id.clone(), component_ref.clone());
        if matches!(kind, ComponentKind::TritInput | ComponentKind::Constant) {
            self.provenance
                .source_copies
                .entry(component_ref)
                .or_default()
                .push(flat_id.clone());
        }

        for port in kind.port_descriptors() {
            let flat_port = FlatPortRef {
                component_id: flat_id.clone(),
                port_id: port.id.clone(),
            };
            let role = match port.direction {
                PortDirection::Input => NodeRole::PrimitiveInput(flat_port),
                PortDirection::Output => NodeRole::PrimitiveOutput(flat_port),
            };
            let node = NodeKey::new(&circuit.id, path, &component.id, &port.id);
            self.nodes.insert(node.clone(), role);
            if is_root {
                self.active_ports.push(ActivePort {
                    reference: QualifiedPortRef::new(
                        &circuit.id,
                        path.iter().cloned(),
                        &component.id,
                        &port.id,
                    ),
                    node,
                    direction: port.direction,
                });
            }
        }
    }

    fn add_instance(
        &mut self,
        circuit: &ProjectCircuit,
        component: &ProjectComponent,
        path: &[String],
        is_root: bool,
    ) -> Result<(), Vec<ProjectDiagnostic>> {
        let module_id = component
            .properties
            .module_id()
            .expect("validated module instance");
        let ports = self
            .project
            .interfaces
            .get(module_id)
            .cloned()
            .expect("validated module interface");
        for port in &ports {
            let node = NodeKey::new(&circuit.id, path, &component.id, &port.id);
            self.nodes.insert(node.clone(), NodeRole::Virtual);
            if is_root {
                self.active_ports.push(ActivePort {
                    reference: QualifiedPortRef::new(
                        &circuit.id,
                        path.iter().cloned(),
                        &component.id,
                        &port.id,
                    ),
                    node,
                    direction: port.direction,
                });
            }
        }

        let mut child_path = path.to_vec();
        child_path.push(component.id.clone());
        self.expand_circuit(module_id, &child_path, false)?;
        for port in ports {
            self.add_instance_alias(circuit, component, path, module_id, &child_path, &port);
        }
        Ok(())
    }

    fn add_instance_alias(
        &mut self,
        parent: &ProjectCircuit,
        instance: &ProjectComponent,
        parent_path: &[String],
        child_id: &str,
        child_path: &[String],
        port: &ModulePort,
    ) {
        let instance_node = NodeKey::new(&parent.id, parent_path, &instance.id, &port.id);
        let boundary_port = match port.direction {
            PortDirection::Input => "out",
            PortDirection::Output => "in",
        };
        let boundary_node = NodeKey::new(
            child_id,
            child_path,
            &port.boundary_component_id,
            boundary_port,
        );
        match port.direction {
            PortDirection::Input => self.add_edge(instance_node, boundary_node, None),
            PortDirection::Output => self.add_edge(boundary_node, instance_node, None),
        }
    }

    fn add_edge(
        &mut self,
        source: NodeKey,
        target: NodeKey,
        reference: Option<QualifiedConnectionRef>,
    ) {
        let references = self
            .edges
            .entry(source)
            .or_default()
            .entry(target)
            .or_default();
        if let Some(reference) = reference {
            references.insert(reference);
        }
    }

    fn finish(
        mut self,
        active_circuit_id: &str,
    ) -> Result<CompiledProject, Vec<ProjectDiagnostic>> {
        let primitive_outputs: Vec<_> = self
            .nodes
            .iter()
            .filter_map(|(node, role)| {
                matches!(role, NodeRole::PrimitiveOutput(_)).then_some(node.clone())
            })
            .collect();
        let mut flat_connections = Vec::new();
        for source in primitive_outputs {
            let source_port = match self.nodes.get(&source) {
                Some(NodeRole::PrimitiveOutput(port)) => port.clone(),
                _ => unreachable!(),
            };
            for (target, references) in self.trace_from(&source) {
                let target_port = match self.nodes.get(&target) {
                    Some(NodeRole::PrimitiveInput(port)) => port.clone(),
                    _ => continue,
                };
                if flat_connections.len() == MAX_EXPANDED_CONNECTIONS {
                    return Err(vec![limit_error(
                        active_circuit_id,
                        format!(
                            "expanded connection count exceeds {}",
                            MAX_EXPANDED_CONNECTIONS
                        ),
                    )]);
                }
                let id = format!("flat-wire-{:05}", flat_connections.len());
                self.provenance
                    .connections
                    .insert(id.clone(), references.into_iter().collect());
                flat_connections.push(Connection {
                    id,
                    source_component_id: source_port.component_id.clone(),
                    source_port_id: source_port.port_id.clone(),
                    target_component_id: target_port.component_id,
                    target_port_id: target_port.port_id,
                });
            }
        }

        let reverse = reverse_graph(&self.edges);
        let mut projection = ProjectionMap::default();
        let mut projection_endpoints = 0_usize;
        for active_port in self.active_ports {
            let endpoints = match active_port.direction {
                PortDirection::Input => {
                    reachable_primitive_ports(&active_port.node, &self.nodes, &self.edges, true)
                }
                PortDirection::Output => {
                    reachable_primitive_ports(&active_port.node, &self.nodes, &reverse, false)
                }
            };
            projection_endpoints = projection_endpoints
                .checked_add(endpoints.len())
                .ok_or_else(|| vec![limit_error(active_circuit_id, "projection count overflow")])?;
            if projection_endpoints > MAX_PROJECTION_ENDPOINTS {
                return Err(vec![limit_error(
                    active_circuit_id,
                    format!(
                        "projection endpoint count {} exceeds {}",
                        projection_endpoints, MAX_PROJECTION_ENDPOINTS
                    ),
                )]);
            }
            projection.ports.insert(
                active_port.reference,
                ProjectionEntry {
                    direction: active_port.direction,
                    endpoints,
                },
            );
        }

        for copies in self.provenance.source_copies.values_mut() {
            copies.sort();
            copies.dedup();
        }
        let components = self.flat_components.into_values().collect();
        Ok(CompiledProject {
            circuit: CircuitDefinition {
                components,
                connections: flat_connections,
            },
            projection,
            provenance: self.provenance,
        })
    }

    fn trace_from(&self, source: &NodeKey) -> BTreeMap<NodeKey, BTreeSet<QualifiedConnectionRef>> {
        let mut reached: BTreeMap<NodeKey, BTreeSet<QualifiedConnectionRef>> = BTreeMap::new();
        let mut queue = VecDeque::from([source.clone()]);
        reached.insert(source.clone(), BTreeSet::new());

        while let Some(node) = queue.pop_front() {
            if node != *source && matches!(self.nodes.get(&node), Some(NodeRole::PrimitiveInput(_)))
            {
                continue;
            }
            let inherited = reached.get(&node).cloned().unwrap_or_default();
            if let Some(targets) = self.edges.get(&node) {
                for (target, edge_refs) in targets {
                    let mut next_refs = inherited.clone();
                    next_refs.extend(edge_refs.iter().cloned());
                    match reached.get_mut(target) {
                        None => {
                            reached.insert(target.clone(), next_refs);
                            queue.push_back(target.clone());
                        }
                        Some(existing) => {
                            let previous_len = existing.len();
                            existing.extend(next_refs);
                            if existing.len() != previous_len {
                                queue.push_back(target.clone());
                            }
                        }
                    }
                }
            }
        }

        reached.remove(source);
        reached.retain(|node, _| matches!(self.nodes.get(node), Some(NodeRole::PrimitiveInput(_))));
        reached
    }
}

fn reverse_graph(
    edges: &BTreeMap<NodeKey, BTreeMap<NodeKey, BTreeSet<QualifiedConnectionRef>>>,
) -> BTreeMap<NodeKey, BTreeMap<NodeKey, BTreeSet<QualifiedConnectionRef>>> {
    let mut reverse = BTreeMap::new();
    for (source, targets) in edges {
        for (target, references) in targets {
            reverse
                .entry(target.clone())
                .or_insert_with(BTreeMap::new)
                .entry(source.clone())
                .or_insert_with(BTreeSet::new)
                .extend(references.iter().cloned());
        }
    }
    reverse
}

fn reachable_primitive_ports(
    start: &NodeKey,
    nodes: &BTreeMap<NodeKey, NodeRole>,
    graph: &BTreeMap<NodeKey, BTreeMap<NodeKey, BTreeSet<QualifiedConnectionRef>>>,
    want_inputs: bool,
) -> Vec<FlatPortRef> {
    let mut endpoints = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::from([start.clone()]);
    visited.insert(start.clone());

    while let Some(node) = queue.pop_front() {
        let endpoint = match nodes.get(&node) {
            Some(NodeRole::PrimitiveInput(port)) if want_inputs => Some(port),
            Some(NodeRole::PrimitiveOutput(port)) if !want_inputs => Some(port),
            _ => None,
        };
        if let Some(endpoint) = endpoint {
            endpoints.insert(endpoint.clone());
            continue;
        }
        if let Some(next_nodes) = graph.get(&node) {
            for next in next_nodes.keys() {
                if visited.insert(next.clone()) {
                    queue.push_back(next.clone());
                }
            }
        }
    }

    endpoints.into_iter().collect()
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

fn limit_error(active_circuit_id: &str, message: impl Into<String>) -> ProjectDiagnostic {
    project_error(
        "HIERARCHY_EXPANSION_LIMIT",
        message.into(),
        active_circuit_id,
    )
}

fn project_error(code: &str, message: String, circuit_id: &str) -> ProjectDiagnostic {
    let location = QualifiedComponentRef::new(circuit_id, [] as [&str; 0], "");
    ProjectDiagnostic {
        code: code.into(),
        severity: Severity::Error,
        message,
        primary_location: Some(ProjectLocation::Component(location.clone())),
        component_refs: vec![location],
        connection_refs: vec![],
        port_refs: vec![],
    }
}
