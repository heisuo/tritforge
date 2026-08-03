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
const MAX_EXPANDED_INSTANCES: usize = 10_000;
const MAX_ANALYSIS_NODES: usize = 50_000;
const MAX_ANALYSIS_EDGES: usize = 100_000;
const MAX_PROVENANCE_REFERENCES: usize = 2_000_000;

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
    pub drivers: Vec<FlatPortRef>,
    pub upstream_boundaries: Vec<QualifiedPortRef>,
    pub direct_drivers: Vec<FlatPortRef>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionMap {
    pub ports: BTreeMap<QualifiedPortRef, ProjectionEntry>,
    pub boundaries: BTreeMap<QualifiedPortRef, ProjectionEntry>,
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
            None,
        )]);
    };

    let fallback_location = growth_location(active);

    let (counts, nested_counts) = analyze_active_circuit(project, &active.id).ok_or_else(|| {
        vec![limit_error(
            fallback_location.clone(),
            "hierarchy count overflowed usize",
        )]
    })?;
    if counts.depth > MAX_HIERARCHY_DEPTH {
        return Err(vec![limit_error(
            budget_growth_location(project, &active.id, &nested_counts, BudgetMetric::Depth)
                .or_else(|| fallback_location.clone()),
            format!(
                "hierarchy depth {} exceeds {}",
                counts.depth, MAX_HIERARCHY_DEPTH
            ),
        )]);
    }
    if counts.primitive_components > MAX_EXPANDED_COMPONENTS {
        return Err(vec![limit_error(
            budget_growth_location(
                project,
                &active.id,
                &nested_counts,
                BudgetMetric::PrimitiveComponents,
            )
            .or_else(|| fallback_location.clone()),
            format!(
                "expanded component count {} exceeds {}",
                counts.primitive_components, MAX_EXPANDED_COMPONENTS
            ),
        )]);
    }
    if counts.expanded_instances > MAX_EXPANDED_INSTANCES {
        return Err(vec![limit_error(
            budget_growth_location(
                project,
                &active.id,
                &nested_counts,
                BudgetMetric::ExpandedInstances,
            )
            .or_else(|| fallback_location.clone()),
            format!(
                "expanded module instance count {} exceeds {}",
                counts.expanded_instances, MAX_EXPANDED_INSTANCES
            ),
        )]);
    }
    if counts.graph_nodes > MAX_ANALYSIS_NODES {
        return Err(vec![limit_error(
            budget_growth_location(
                project,
                &active.id,
                &nested_counts,
                BudgetMetric::GraphNodes,
            )
            .or_else(|| fallback_location.clone()),
            format!(
                "symbolic analysis node count {} exceeds {}",
                counts.graph_nodes, MAX_ANALYSIS_NODES
            ),
        )]);
    }
    if counts.graph_edges > MAX_ANALYSIS_EDGES {
        return Err(vec![limit_error(
            budget_growth_location(
                project,
                &active.id,
                &nested_counts,
                BudgetMetric::GraphEdges,
            )
            .or_else(|| fallback_location.clone()),
            format!(
                "symbolic analysis edge count {} exceeds {}",
                counts.graph_edges, MAX_ANALYSIS_EDGES
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
    let mut analyzer = HierarchyAnalyzer {
        project,
        circuits,
        nodes: BTreeMap::new(),
        edges: BTreeMap::new(),
        active_ports: Vec::new(),
        boundary_ports: Vec::new(),
        growth_location: budget_growth_location(
            project,
            &active.id,
            &nested_counts,
            BudgetMetric::GraphEdges,
        )
        .or(fallback_location),
    };
    analyzer.expand_circuit(active_circuit_id, &[], true)?;
    let wiring = analyzer.analyze_wiring()?;
    Ok(materialize_project(project, active_circuit_id, wiring))
}

#[derive(Debug, Clone, Copy)]
struct ExpansionCounts {
    primitive_components: usize,
    expanded_instances: usize,
    graph_nodes: usize,
    graph_edges: usize,
    depth: usize,
}

fn analyze_active_circuit(
    project: &ValidatedProject,
    active_circuit_id: &str,
) -> Option<(ExpansionCounts, BTreeMap<String, ExpansionCounts>)> {
    let order = dependency_postorder(active_circuit_id, &project.dependencies)?;
    let mut nested_counts = BTreeMap::new();
    for circuit_id in order {
        let counts = count_circuit(project, &circuit_id, false, &nested_counts)?;
        nested_counts.insert(circuit_id, counts);
    }
    let active_counts = count_circuit(project, active_circuit_id, true, &nested_counts)?;
    Some((active_counts, nested_counts))
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
        expanded_instances: 0,
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
                counts.expanded_instances = counts
                    .expanded_instances
                    .checked_add(1)?
                    .checked_add(child.expanded_instances)?;
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

#[derive(Clone, Copy)]
enum BudgetMetric {
    PrimitiveComponents,
    ExpandedInstances,
    GraphNodes,
    GraphEdges,
    Depth,
}

fn budget_growth_location(
    project: &ValidatedProject,
    active_circuit_id: &str,
    nested_counts: &BTreeMap<String, ExpansionCounts>,
    metric: BudgetMetric,
) -> Option<QualifiedComponentRef> {
    let circuits: BTreeMap<_, _> = project
        .project
        .circuits
        .iter()
        .map(|circuit| (circuit.id.as_str(), circuit))
        .collect();
    let mut circuit_id = active_circuit_id;
    let mut instance_path = Vec::new();
    let mut location = None;

    loop {
        let circuit = circuits.get(circuit_id)?;
        let selected = circuit
            .components
            .iter()
            .filter(|component| component.type_id == MODULE_INSTANCE)
            .filter_map(|component| {
                let module_id = component.properties.module_id()?;
                let child = nested_counts.get(module_id)?;
                let port_count = project.interfaces.get(module_id)?.len();
                let contribution = match metric {
                    BudgetMetric::PrimitiveComponents => child.primitive_components,
                    BudgetMetric::ExpandedInstances => child.expanded_instances.checked_add(1)?,
                    BudgetMetric::GraphNodes => child.graph_nodes.checked_add(port_count)?,
                    BudgetMetric::GraphEdges => child.graph_edges.checked_add(port_count)?,
                    BudgetMetric::Depth => child.depth,
                };
                Some((contribution, component, module_id))
            })
            .max_by(|left, right| {
                left.0
                    .cmp(&right.0)
                    .then_with(|| right.1.id.cmp(&left.1.id))
            });
        let Some((contribution, component, module_id)) = selected else {
            break;
        };
        if contribution == 0 {
            break;
        }
        location = Some(QualifiedComponentRef::new(
            &circuit.id,
            instance_path.iter().cloned(),
            &component.id,
        ));
        instance_path.push(component.id.clone());
        circuit_id = module_id;
    }

    location
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

#[derive(Clone)]
struct ActivePort {
    reference: QualifiedPortRef,
    node: NodeKey,
    direction: PortDirection,
}

struct HierarchyAnalyzer<'a> {
    project: &'a ValidatedProject,
    circuits: BTreeMap<String, ProjectCircuit>,
    nodes: BTreeMap<NodeKey, NodeRole>,
    edges: BTreeMap<NodeKey, BTreeMap<NodeKey, BTreeSet<QualifiedConnectionRef>>>,
    active_ports: Vec<ActivePort>,
    boundary_ports: Vec<ActivePort>,
    growth_location: Option<QualifiedComponentRef>,
}

struct WiringPlan {
    connections: Vec<Connection>,
    projection: ProjectionMap,
    connection_provenance: BTreeMap<String, Vec<QualifiedConnectionRef>>,
}

struct ReachabilityIndex {
    node_indexes: BTreeMap<NodeKey, usize>,
    scc_of: Vec<usize>,
    roots: Vec<usize>,
    expressions: Vec<EndpointExpression>,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct EndpointExpression {
    endpoints: Vec<FlatPortRef>,
    children: Vec<usize>,
}

impl ReachabilityIndex {
    fn new(
        nodes: &BTreeMap<NodeKey, NodeRole>,
        graph: &BTreeMap<NodeKey, BTreeMap<NodeKey, BTreeSet<QualifiedConnectionRef>>>,
        want_inputs: bool,
    ) -> Self {
        let node_keys: Vec<_> = nodes.keys().cloned().collect();
        let node_indexes: BTreeMap<_, _> = node_keys
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, node)| (node, index))
            .collect();
        let mut adjacency = vec![Vec::new(); node_keys.len()];
        for (index, node) in node_keys.iter().enumerate() {
            if endpoint_for_role(nodes.get(node), want_inputs).is_some() {
                continue;
            }
            if let Some(targets) = graph.get(node) {
                adjacency[index].extend(
                    targets
                        .keys()
                        .filter_map(|target| node_indexes.get(target).copied()),
                );
            }
        }
        let mut reverse = vec![Vec::new(); node_keys.len()];
        for (source, targets) in adjacency.iter().enumerate() {
            for &target in targets {
                reverse[target].push(source);
            }
        }
        let order = graph_finish_order(&adjacency);
        let (scc_count, scc_of) = graph_components(&reverse, &order);
        let mut dag_sets = vec![BTreeSet::new(); scc_count];
        for (source, targets) in adjacency.iter().enumerate() {
            for &target in targets {
                let from = scc_of[source];
                let to = scc_of[target];
                if from != to {
                    dag_sets[from].insert(to);
                }
            }
        }
        let mut endpoints = vec![Vec::new(); scc_count];
        for (index, node) in node_keys.iter().enumerate() {
            if let Some(endpoint) = endpoint_for_role(nodes.get(node), want_inputs) {
                endpoints[scc_of[index]].push(endpoint.clone());
            }
        }
        let dag: Vec<Vec<_>> = dag_sets
            .into_iter()
            .map(|targets| targets.into_iter().collect())
            .collect();
        let mut expressions = vec![EndpointExpression {
            endpoints: Vec::new(),
            children: Vec::new(),
        }];
        let mut interned = BTreeMap::from([((Vec::new(), Vec::new()), 0_usize)]);
        let mut roots = vec![0_usize; scc_count];
        for scc in graph_finish_order(&dag) {
            endpoints[scc].sort();
            endpoints[scc].dedup();
            let child_roots: Vec<_> = dag[scc]
                .iter()
                .map(|child| roots[*child])
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            if endpoints[scc].is_empty() && child_roots.len() == 1 {
                roots[scc] = child_roots[0];
                continue;
            }
            let key = (endpoints[scc].clone(), child_roots);
            roots[scc] = match interned.get(&key) {
                Some(root) => *root,
                None => {
                    let root = expressions.len();
                    expressions.push(EndpointExpression {
                        endpoints: key.0.clone(),
                        children: key.1.clone(),
                    });
                    interned.insert(key, root);
                    root
                }
            };
        }
        Self {
            node_indexes,
            scc_of,
            roots,
            expressions,
        }
    }

    fn ports(
        &self,
        start: &NodeKey,
        cache: &mut BTreeMap<usize, Vec<FlatPortRef>>,
    ) -> Vec<FlatPortRef> {
        let root = self.start_root(start);
        if let Some(ports) = cache.get(&root) {
            return ports.clone();
        }
        let mut visited = BTreeSet::from([root]);
        let mut stack = vec![root];
        let mut ports = BTreeSet::new();
        while let Some(expression_id) = stack.pop() {
            if let Some(cached) = cache.get(&expression_id) {
                ports.extend(cached.iter().cloned());
                continue;
            }
            let expression = &self.expressions[expression_id];
            ports.extend(expression.endpoints.iter().cloned());
            for &child in &expression.children {
                if visited.insert(child) {
                    stack.push(child);
                }
            }
        }
        let ports: Vec<_> = ports.into_iter().collect();
        cache.insert(root, ports.clone());
        ports
    }

    fn start_root(&self, start: &NodeKey) -> usize {
        let index = self
            .node_indexes
            .get(start)
            .expect("active port belongs to the analyzed graph");
        self.roots[self.scc_of[*index]]
    }
}

fn endpoint_for_role(role: Option<&NodeRole>, want_inputs: bool) -> Option<&FlatPortRef> {
    match (role, want_inputs) {
        (Some(NodeRole::PrimitiveInput(port)), true)
        | (Some(NodeRole::PrimitiveOutput(port)), false) => Some(port),
        _ => None,
    }
}

impl HierarchyAnalyzer<'_> {
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
            let role = if is_input {
                let flat_port = FlatPortRef {
                    component_id: flat_id.clone(),
                    port_id: "out".into(),
                };
                NodeRole::PrimitiveOutput(flat_port)
            } else {
                let flat_port = FlatPortRef {
                    component_id: flat_id.clone(),
                    port_id: "in".into(),
                };
                NodeRole::PrimitiveInput(flat_port)
            };
            self.nodes.insert(node.clone(), role);
        } else {
            self.nodes.insert(node.clone(), NodeRole::Virtual);
        }
        if is_root {
            let port = ActivePort {
                reference: QualifiedPortRef::new(
                    &circuit.id,
                    path.iter().cloned(),
                    &component.id,
                    fixed_port,
                ),
                node,
                direction,
            };
            self.active_ports.push(port.clone());
            self.boundary_ports.push(port);
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
            let boundary = ActivePort {
                reference: QualifiedPortRef::new(
                    &circuit.id,
                    path.iter().cloned(),
                    &component.id,
                    &port.id,
                ),
                node,
                direction: port.direction,
            };
            self.boundary_ports.push(boundary.clone());
            if is_root {
                self.active_ports.push(boundary);
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

    fn analyze_wiring(&self) -> Result<WiringPlan, Vec<ProjectDiagnostic>> {
        let primitive_outputs: Vec<_> = self
            .nodes
            .iter()
            .filter_map(|(node, role)| {
                matches!(role, NodeRole::PrimitiveOutput(_)).then_some(node.clone())
            })
            .collect();
        let reverse = reverse_graph(&self.edges);
        let forward_projection = ReachabilityIndex::new(&self.nodes, &self.edges, true);
        let reverse_projection = ReachabilityIndex::new(&self.nodes, &reverse, false);
        let mut forward_ports = BTreeMap::new();
        let mut reverse_ports = BTreeMap::new();

        let mut connection_count = 0_usize;
        for source in &primitive_outputs {
            let additional = forward_projection.ports(source, &mut forward_ports).len();
            connection_count = connection_count.checked_add(additional).ok_or_else(|| {
                vec![limit_error(
                    self.growth_location
                        .clone()
                        .or_else(|| Some(node_location(source))),
                    "expanded connection count overflowed usize",
                )]
            })?;
            if connection_count > MAX_EXPANDED_CONNECTIONS {
                return Err(vec![limit_error(
                    self.growth_location
                        .clone()
                        .or_else(|| Some(node_location(source))),
                    format!(
                        "expanded connection count is at least {connection_count}, exceeding {}",
                        MAX_EXPANDED_CONNECTIONS
                    ),
                )]);
            }
        }

        let mut projection_endpoints = 0_usize;
        for active_port in self.active_ports.iter().chain(&self.boundary_ports) {
            let additional = match active_port.direction {
                PortDirection::Input => forward_projection
                    .ports(&active_port.node, &mut forward_ports)
                    .len()
                    .checked_add(
                        reverse_projection
                            .ports(&active_port.node, &mut reverse_ports)
                            .len(),
                    )
                    .ok_or_else(|| {
                        vec![limit_error(
                            self.growth_location
                                .clone()
                                .or_else(|| Some(port_location(&active_port.reference))),
                            "projection endpoint count overflowed usize",
                        )]
                    })?,
                PortDirection::Output => reverse_projection
                    .ports(&active_port.node, &mut reverse_ports)
                    .len(),
            };
            projection_endpoints =
                projection_endpoints
                    .checked_add(additional)
                    .ok_or_else(|| {
                        vec![limit_error(
                            self.growth_location
                                .clone()
                                .or_else(|| Some(port_location(&active_port.reference))),
                            "projection endpoint count overflowed usize",
                        )]
                    })?;
            if projection_endpoints > MAX_PROJECTION_ENDPOINTS {
                return Err(vec![limit_error(
                    self.growth_location
                        .clone()
                        .or_else(|| Some(port_location(&active_port.reference))),
                    format!(
                        "projection endpoint count is at least {projection_endpoints}, exceeding {}",
                        MAX_PROJECTION_ENDPOINTS
                    ),
                )]);
            }
        }

        let mut flat_connections = Vec::new();
        let mut connection_provenance = BTreeMap::new();
        let primitive_inputs: BTreeMap<_, _> = self
            .nodes
            .iter()
            .filter_map(|(node, role)| match role {
                NodeRole::PrimitiveInput(port) => Some((port.clone(), node.clone())),
                _ => None,
            })
            .collect();
        let mut provenance_items = 0_usize;
        for source in primitive_outputs {
            let source_port = match self.nodes.get(&source) {
                Some(NodeRole::PrimitiveOutput(port)) => port.clone(),
                _ => unreachable!(),
            };
            let targets = forward_projection.ports(&source, &mut forward_ports);
            if targets.is_empty() {
                continue;
            }
            let reachable = self.reachable_from(&source);
            for target_port in targets {
                let target = primitive_inputs
                    .get(&target_port)
                    .expect("reachable primitive input belongs to the analyzed graph");
                let references = self.references_between(
                    &source,
                    target,
                    &reachable,
                    &reverse,
                    &mut provenance_items,
                )?;
                let id = format!("flat-wire-{:05}", flat_connections.len());
                connection_provenance.insert(id.clone(), references.into_iter().collect());
                flat_connections.push(Connection {
                    id,
                    source_component_id: source_port.component_id.clone(),
                    source_port_id: source_port.port_id.clone(),
                    target_component_id: target_port.component_id,
                    target_port_id: target_port.port_id,
                });
            }
        }

        let mut projection = ProjectionMap::default();
        let boundary_nodes: BTreeMap<_, _> = self
            .boundary_ports
            .iter()
            .map(|port| (port.node.clone(), port.reference.clone()))
            .collect();
        for active_port in &self.active_ports {
            let endpoints = forward_projection.ports(&active_port.node, &mut forward_ports);
            let drivers = reverse_projection.ports(&active_port.node, &mut reverse_ports);
            projection.ports.insert(
                active_port.reference.clone(),
                ProjectionEntry {
                    direction: active_port.direction,
                    endpoints,
                    drivers,
                    upstream_boundaries: Vec::new(),
                    direct_drivers: Vec::new(),
                },
            );
        }
        for boundary_port in &self.boundary_ports {
            let endpoints = forward_projection.ports(&boundary_port.node, &mut forward_ports);
            let drivers = reverse_projection.ports(&boundary_port.node, &mut reverse_ports);
            let (upstream_boundaries, direct_drivers) =
                self.boundary_sources(&boundary_port.node, &reverse, &boundary_nodes);
            projection.boundaries.insert(
                boundary_port.reference.clone(),
                ProjectionEntry {
                    direction: boundary_port.direction,
                    endpoints,
                    drivers,
                    upstream_boundaries,
                    direct_drivers,
                },
            );
        }

        Ok(WiringPlan {
            connections: flat_connections,
            projection,
            connection_provenance,
        })
    }

    fn boundary_sources(
        &self,
        start: &NodeKey,
        reverse: &BTreeMap<NodeKey, BTreeMap<NodeKey, BTreeSet<QualifiedConnectionRef>>>,
        boundary_nodes: &BTreeMap<NodeKey, QualifiedPortRef>,
    ) -> (Vec<QualifiedPortRef>, Vec<FlatPortRef>) {
        if let Some(NodeRole::PrimitiveOutput(driver)) = self.nodes.get(start) {
            return (Vec::new(), vec![driver.clone()]);
        }
        let mut upstream_boundaries = BTreeSet::new();
        let mut direct_drivers = BTreeSet::new();
        let mut visited = BTreeSet::from([start.clone()]);
        let mut queue = VecDeque::from([start.clone()]);
        while let Some(node) = queue.pop_front() {
            if let Some(predecessors) = reverse.get(&node) {
                for predecessor in predecessors.keys() {
                    if predecessor != start
                        && let Some(boundary) = boundary_nodes.get(predecessor)
                    {
                        upstream_boundaries.insert(boundary.clone());
                        continue;
                    }
                    if let Some(NodeRole::PrimitiveOutput(driver)) = self.nodes.get(predecessor) {
                        direct_drivers.insert(driver.clone());
                        continue;
                    }
                    if visited.insert(predecessor.clone()) {
                        queue.push_back(predecessor.clone());
                    }
                }
            }
        }
        (
            upstream_boundaries.into_iter().collect(),
            direct_drivers.into_iter().collect(),
        )
    }

    fn references_between(
        &self,
        source: &NodeKey,
        target: &NodeKey,
        reachable: &BTreeSet<NodeKey>,
        reverse: &BTreeMap<NodeKey, BTreeMap<NodeKey, BTreeSet<QualifiedConnectionRef>>>,
        provenance_items: &mut usize,
    ) -> Result<BTreeSet<QualifiedConnectionRef>, Vec<ProjectDiagnostic>> {
        let mut visited = BTreeSet::from([target.clone()]);
        let mut queue = VecDeque::from([target.clone()]);
        let mut references = BTreeSet::new();
        while let Some(node) = queue.pop_front() {
            if node == *source {
                continue;
            }
            if let Some(predecessors) = reverse.get(&node) {
                for (predecessor, edge_refs) in predecessors {
                    if !reachable.contains(predecessor) {
                        continue;
                    }
                    references.extend(edge_refs.iter().cloned());
                    if visited.insert(predecessor.clone()) {
                        queue.push_back(predecessor.clone());
                    }
                }
            }
        }
        *provenance_items = provenance_items
            .checked_add(references.len())
            .ok_or_else(|| vec![self.provenance_limit_error(source, usize::MAX)])?;
        if *provenance_items > MAX_PROVENANCE_REFERENCES {
            return Err(vec![self.provenance_limit_error(source, *provenance_items)]);
        }
        Ok(references)
    }

    fn reachable_from(&self, source: &NodeKey) -> BTreeSet<NodeKey> {
        let mut reached = BTreeSet::from([source.clone()]);
        let mut queue = VecDeque::from([source.clone()]);
        while let Some(node) = queue.pop_front() {
            if node != *source && matches!(self.nodes.get(&node), Some(NodeRole::PrimitiveInput(_)))
            {
                continue;
            }
            if let Some(targets) = self.edges.get(&node) {
                for target in targets.keys() {
                    if reached.insert(target.clone()) {
                        queue.push_back(target.clone());
                    }
                }
            }
        }
        reached
    }

    fn provenance_limit_error(&self, source: &NodeKey, count: usize) -> ProjectDiagnostic {
        limit_error(
            self.growth_location
                .clone()
                .or_else(|| Some(node_location(source))),
            format!(
                "provenance reference count is at least {count}, exceeding {MAX_PROVENANCE_REFERENCES}"
            ),
        )
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

fn graph_finish_order(adjacency: &[Vec<usize>]) -> Vec<usize> {
    let mut visited = vec![false; adjacency.len()];
    let mut order = Vec::with_capacity(adjacency.len());
    for start in 0..adjacency.len() {
        if visited[start] {
            continue;
        }
        visited[start] = true;
        let mut stack = vec![(start, 0_usize)];
        while let Some((node, next_index)) = stack.last_mut() {
            if let Some(&next) = adjacency[*node].get(*next_index) {
                *next_index += 1;
                if !visited[next] {
                    visited[next] = true;
                    stack.push((next, 0));
                }
            } else {
                let (finished, _) = stack.pop().expect("DFS stack is not empty");
                order.push(finished);
            }
        }
    }
    order
}

fn graph_components(reverse: &[Vec<usize>], order: &[usize]) -> (usize, Vec<usize>) {
    let mut component_of = vec![usize::MAX; reverse.len()];
    let mut component_count = 0_usize;
    for &start in order.iter().rev() {
        if component_of[start] != usize::MAX {
            continue;
        }
        component_of[start] = component_count;
        let mut stack = vec![start];
        while let Some(node) = stack.pop() {
            for &next in &reverse[node] {
                if component_of[next] == usize::MAX {
                    component_of[next] = component_count;
                    stack.push(next);
                }
            }
        }
        component_count += 1;
    }
    (component_count, component_of)
}

fn materialize_project(
    project: &ValidatedProject,
    active_circuit_id: &str,
    wiring: WiringPlan,
) -> CompiledProject {
    let circuits: BTreeMap<_, _> = project
        .project
        .circuits
        .iter()
        .map(|circuit| (circuit.id.as_str(), circuit))
        .collect();
    let mut components = BTreeMap::new();
    let mut provenance = ProvenanceMap {
        connections: wiring.connection_provenance,
        ..ProvenanceMap::default()
    };
    let mut stack = vec![(active_circuit_id.to_owned(), Vec::<String>::new(), true)];

    while let Some((circuit_id, path, is_root)) = stack.pop() {
        let circuit = circuits
            .get(circuit_id.as_str())
            .expect("validated circuit exists");
        for component in &circuit.components {
            let flat_id = flat_component_id(&path, &component.id);
            let component_ref =
                QualifiedComponentRef::new(&circuit.id, path.iter().cloned(), &component.id);
            match component.type_id.as_str() {
                MODULE_INPUT | MODULE_OUTPUT if !is_root => {}
                MODULE_INPUT => {
                    components.insert(
                        flat_id.clone(),
                        ComponentInstance {
                            id: flat_id.clone(),
                            type_id: "source.trit_input".into(),
                            properties: ComponentProperties {
                                value: component.properties.preview_value(),
                            },
                        },
                    );
                    provenance
                        .source_copies
                        .entry(component_ref.clone())
                        .or_default()
                        .push(flat_id.clone());
                    provenance.components.insert(flat_id, component_ref);
                }
                MODULE_OUTPUT => {
                    components.insert(
                        flat_id.clone(),
                        ComponentInstance {
                            id: flat_id.clone(),
                            type_id: "sink.probe".into(),
                            properties: ComponentProperties::default(),
                        },
                    );
                    provenance.components.insert(flat_id, component_ref);
                }
                MODULE_INSTANCE => {
                    let module_id = component
                        .properties
                        .module_id()
                        .expect("validated module instance");
                    let mut child_path = path.clone();
                    child_path.push(component.id.clone());
                    stack.push((module_id.to_owned(), child_path, false));
                }
                _ => {
                    let kind = ComponentKind::from_type_id(&component.type_id)
                        .expect("validated primitive component type");
                    components.insert(
                        flat_id.clone(),
                        ComponentInstance {
                            id: flat_id.clone(),
                            type_id: component.type_id.clone(),
                            properties: ComponentProperties {
                                value: component.properties.known_value(),
                            },
                        },
                    );
                    if matches!(kind, ComponentKind::TritInput | ComponentKind::Constant) {
                        provenance
                            .source_copies
                            .entry(component_ref.clone())
                            .or_default()
                            .push(flat_id.clone());
                    }
                    provenance.components.insert(flat_id, component_ref);
                }
            }
        }
    }

    for copies in provenance.source_copies.values_mut() {
        copies.sort();
        copies.dedup();
    }
    CompiledProject {
        circuit: CircuitDefinition {
            components: components.into_values().collect(),
            connections: wiring.connections,
        },
        projection: wiring.projection,
        provenance,
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

fn growth_location(active: &ProjectCircuit) -> Option<QualifiedComponentRef> {
    active
        .components
        .iter()
        .find(|component| component.type_id == MODULE_INSTANCE)
        .or_else(|| active.components.last())
        .map(|component| QualifiedComponentRef::new(&active.id, [] as [&str; 0], &component.id))
}

fn node_location(node: &NodeKey) -> QualifiedComponentRef {
    QualifiedComponentRef::new(
        &node.circuit_id,
        node.instance_path.iter().cloned(),
        &node.component_id,
    )
}

fn port_location(port: &QualifiedPortRef) -> QualifiedComponentRef {
    QualifiedComponentRef::new(
        &port.circuit_id,
        port.instance_path.iter().cloned(),
        &port.component_id,
    )
}

fn limit_error(
    location: Option<QualifiedComponentRef>,
    message: impl Into<String>,
) -> ProjectDiagnostic {
    project_error("HIERARCHY_EXPANSION_LIMIT", message.into(), location)
}

fn project_error(
    code: &str,
    message: String,
    location: Option<QualifiedComponentRef>,
) -> ProjectDiagnostic {
    ProjectDiagnostic {
        code: code.into(),
        severity: Severity::Error,
        message,
        primary_location: location.clone().map(ProjectLocation::Component),
        component_refs: location.into_iter().collect(),
        connection_refs: vec![],
        port_refs: vec![],
    }
}
