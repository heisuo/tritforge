use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::catalog::{ComponentKind, PortDirection};
use crate::diagnostic::Severity;
use crate::project::{
    ProjectCircuit, ProjectCircuitKind, ProjectComponent, ProjectDiagnostic, ProjectDiagnosticSet,
    ProjectDocument, ProjectLocation, QualifiedComponentRef, QualifiedConnectionRef,
    QualifiedPortRef,
};

const MODULE_INPUT: &str = "project.module_input";
const MODULE_OUTPUT: &str = "project.module_output";
const MODULE_INSTANCE: &str = "project.module_instance";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModulePort {
    pub id: String,
    pub label: String,
    pub direction: PortDirection,
    pub boundary_component_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedProject {
    pub project: ProjectDocument,
    pub interfaces: BTreeMap<String, Vec<ModulePort>>,
    pub dependencies: BTreeMap<String, Vec<String>>,
    pub warnings: Vec<ProjectDiagnostic>,
}

pub fn validate_project(
    project: ProjectDocument,
) -> Result<ValidatedProject, Vec<ProjectDiagnostic>> {
    let mut diagnostics = ProjectDiagnosticSet::new();
    validate_project_header(&project, &mut diagnostics);
    let circuit_counts = count_ids(project.circuits.iter().map(|circuit| circuit.id.as_str()));

    for (circuit_id, count) in &circuit_counts {
        if *count > 1 {
            diagnostics.insert(error(
                "DUPLICATE_CIRCUIT_ID",
                format!("circuit id '{circuit_id}' is used more than once"),
                circuit_id,
                &[],
                &[],
                &[],
            ));
        }
    }

    validate_root(&project, &circuit_counts, &mut diagnostics);

    let unique_circuits: BTreeMap<_, _> = project
        .circuits
        .iter()
        .filter(|circuit| circuit_counts.get(&circuit.id) == Some(&1))
        .map(|circuit| (circuit.id.clone(), circuit))
        .collect();

    for circuit in &project.circuits {
        validate_local_structure(circuit, &mut diagnostics);
    }

    let interfaces = build_interfaces(&project.circuits, &mut diagnostics);
    let interface_index = build_interface_index(&project.circuits);
    let dependency_analysis = validate_instances_and_connections(
        &project.circuits,
        &unique_circuits,
        &interface_index,
        &mut diagnostics,
    );
    validate_dependency_graph(
        &dependency_analysis.dependencies,
        &dependency_analysis.instances,
        &mut diagnostics,
    );

    let diagnostics = diagnostics.into_vec();
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error)
    {
        return Err(diagnostics);
    }

    Ok(ValidatedProject {
        project,
        interfaces,
        dependencies: dependency_analysis.dependencies,
        warnings: diagnostics,
    })
}

fn validate_project_header(project: &ProjectDocument, diagnostics: &mut ProjectDiagnosticSet) {
    if project.format != "logsim-ternary" {
        diagnostics.insert(error(
            "INVALID_PROJECT_FORMAT",
            format!("unsupported project format '{}'", project.format),
            &project.root_circuit_id,
            &[],
            &[],
            &[],
        ));
    }
    if project.version != 2 {
        diagnostics.insert(error(
            "UNSUPPORTED_PROJECT_VERSION",
            format!("unsupported project version '{}'", project.version),
            &project.root_circuit_id,
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
        diagnostics.insert(error(
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
        diagnostics.insert(error(
            "INVALID_CIRCUIT_NAME",
            "circuit names must not be empty".into(),
            &project.root_circuit_id,
            &[],
            &[],
            &[],
        ));
    }
}

fn validate_root(
    project: &ProjectDocument,
    circuit_counts: &BTreeMap<String, usize>,
    diagnostics: &mut ProjectDiagnosticSet,
) {
    let main_circuits: Vec<_> = project
        .circuits
        .iter()
        .filter(|circuit| circuit.kind == ProjectCircuitKind::Main)
        .collect();
    let root = project
        .circuits
        .iter()
        .find(|circuit| circuit.id == project.root_circuit_id);
    let valid = main_circuits.len() == 1
        && root.is_some_and(|circuit| circuit.kind == ProjectCircuitKind::Main)
        && circuit_counts.get(&project.root_circuit_id) == Some(&1);

    if !valid {
        diagnostics.insert(error(
            "INVALID_ROOT_CIRCUIT",
            "project must contain exactly one main circuit matching rootCircuitId".into(),
            &project.root_circuit_id,
            &[],
            &[],
            &[],
        ));
    }
}

fn validate_local_structure(circuit: &ProjectCircuit, diagnostics: &mut ProjectDiagnosticSet) {
    let component_counts = count_ids(
        circuit
            .components
            .iter()
            .map(|component| component.id.as_str()),
    );
    for (component_id, count) in &component_counts {
        if *count > 1 {
            diagnostics.insert(error(
                "DUPLICATE_COMPONENT_ID",
                format!("component id '{component_id}' is used more than once"),
                &circuit.id,
                &[component_id],
                &[],
                &[],
            ));
        }
    }

    let connection_counts = count_ids(
        circuit
            .connections
            .iter()
            .map(|connection| connection.id.as_str()),
    );
    for (connection_id, count) in &connection_counts {
        if *count > 1 {
            diagnostics.insert(error(
                "DUPLICATE_CONNECTION_ID",
                format!("connection id '{connection_id}' is used more than once"),
                &circuit.id,
                &[],
                &[connection_id],
                &[],
            ));
        }
    }

    for component in &circuit.components {
        validate_component(circuit, component, diagnostics);
    }
}

fn validate_component(
    circuit: &ProjectCircuit,
    component: &ProjectComponent,
    diagnostics: &mut ProjectDiagnosticSet,
) {
    match component.type_id.as_str() {
        MODULE_INPUT | MODULE_OUTPUT => {
            if circuit.kind != ProjectCircuitKind::Module {
                diagnostics.insert(error(
                    "INVALID_MODULE_BOUNDARY",
                    format!(
                        "component '{}' is a module boundary outside a module circuit",
                        component.id
                    ),
                    &circuit.id,
                    &[&component.id],
                    &[],
                    &[],
                ));
            }
            if !valid_boundary_properties(component) {
                diagnostics.insert(error(
                    "INVALID_PROPERTY",
                    format!("module boundary '{}' has invalid properties", component.id),
                    &circuit.id,
                    &[&component.id],
                    &[],
                    &[],
                ));
            }
        }
        MODULE_INSTANCE => {
            if !valid_instance_properties(component) {
                diagnostics.insert(error(
                    "INVALID_PROPERTY",
                    format!("module instance '{}' has invalid properties", component.id),
                    &circuit.id,
                    &[&component.id],
                    &[],
                    &[],
                ));
            }
        }
        type_id => match ComponentKind::from_type_id(type_id) {
            Some(kind) if valid_builtin_properties(component, kind) => {}
            Some(_) => {
                diagnostics.insert(error(
                    "INVALID_PROPERTY",
                    format!("component '{}' has invalid properties", component.id),
                    &circuit.id,
                    &[&component.id],
                    &[],
                    &[],
                ));
            }
            None => {
                diagnostics.insert(error(
                    "UNKNOWN_COMPONENT_TYPE",
                    format!(
                        "component '{}' uses unknown type '{}'",
                        component.id, component.type_id
                    ),
                    &circuit.id,
                    &[&component.id],
                    &[],
                    &[],
                ));
            }
        },
    }
}

fn valid_boundary_properties(component: &ProjectComponent) -> bool {
    let has_identity = component
        .properties
        .port_id()
        .is_some_and(|port_id| !port_id.trim().is_empty())
        && component
            .properties
            .label()
            .is_some_and(|label| !label.trim().is_empty());
    if component.type_id == MODULE_INPUT {
        has_identity
            && component.properties.preview_value().is_some()
            && has_only_properties(component, &["portId", "label", "previewValue"])
    } else {
        has_identity && has_only_properties(component, &["portId", "label"])
    }
}

fn valid_instance_properties(component: &ProjectComponent) -> bool {
    component
        .properties
        .module_id()
        .is_some_and(|module_id| !module_id.trim().is_empty())
        && component
            .properties
            .label()
            .is_some_and(|label| !label.trim().is_empty())
        && has_only_properties(component, &["moduleId", "label"])
}

fn valid_builtin_properties(component: &ProjectComponent, kind: ComponentKind) -> bool {
    let value = component.properties.get("value");
    let valid_value = match kind {
        ComponentKind::TritInput | ComponentKind::Constant => {
            value.is_none() || component.properties.known_value().is_some()
        }
        _ => value.is_none(),
    };
    let valid_label = component
        .properties
        .get("label")
        .is_none_or(|label| label.as_str().is_some_and(|label| !label.is_empty()));
    valid_value && valid_label
}

fn has_only_properties(component: &ProjectComponent, allowed: &[&str]) -> bool {
    component
        .properties
        .keys()
        .all(|key| allowed.contains(&key))
}

fn build_interfaces(
    circuits: &[ProjectCircuit],
    diagnostics: &mut ProjectDiagnosticSet,
) -> BTreeMap<String, Vec<ModulePort>> {
    let mut interfaces = BTreeMap::new();

    for circuit in circuits
        .iter()
        .filter(|circuit| circuit.kind == ProjectCircuitKind::Module)
    {
        let mut ports = Vec::new();
        let mut port_components: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for component in &circuit.components {
            let direction = match component.type_id.as_str() {
                MODULE_INPUT => Some(PortDirection::Input),
                MODULE_OUTPUT => Some(PortDirection::Output),
                _ => None,
            };
            let (Some(direction), Some(port_id), Some(label)) = (
                direction,
                component.properties.port_id(),
                component.properties.label(),
            ) else {
                continue;
            };

            port_components
                .entry(port_id.to_owned())
                .or_default()
                .push(component.id.clone());
            ports.push(ModulePort {
                id: port_id.to_owned(),
                label: label.to_owned(),
                direction,
                boundary_component_id: component.id.clone(),
            });
        }

        for (port_id, component_ids) in port_components {
            if component_ids.len() > 1 {
                let component_refs: Vec<_> = component_ids.iter().map(String::as_str).collect();
                let port_refs: Vec<_> = component_ids
                    .iter()
                    .map(|component_id| (component_id.as_str(), port_id.as_str()))
                    .collect();
                diagnostics.insert(error(
                    "DUPLICATE_MODULE_PORT_ID",
                    format!("module port id '{port_id}' is used more than once"),
                    &circuit.id,
                    &component_refs,
                    &[],
                    &port_refs,
                ));
            }
        }
        interfaces.insert(circuit.id.clone(), ports);
    }

    interfaces
}

fn build_interface_index(
    circuits: &[ProjectCircuit],
) -> BTreeMap<String, BTreeMap<String, InterfacePort>> {
    circuits
        .iter()
        .filter(|circuit| circuit.kind == ProjectCircuitKind::Module)
        .map(|circuit| {
            let mut index = BTreeMap::new();
            for component in &circuit.components {
                let direction = match component.type_id.as_str() {
                    MODULE_INPUT => PortDirection::Input,
                    MODULE_OUTPUT => PortDirection::Output,
                    _ => continue,
                };
                let Some(port_id) = component.properties.port_id() else {
                    continue;
                };
                let port = if valid_boundary_properties(component) {
                    InterfacePort::Direction(direction)
                } else {
                    InterfacePort::Unresolvable
                };
                index
                    .entry(port_id.to_owned())
                    .and_modify(|entry| *entry = InterfacePort::Ambiguous)
                    .or_insert(port);
            }
            (circuit.id.clone(), index)
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InterfacePort {
    Direction(PortDirection),
    Unresolvable,
    Ambiguous,
}

fn validate_instances_and_connections(
    circuits: &[ProjectCircuit],
    unique_circuits: &BTreeMap<String, &ProjectCircuit>,
    interface_index: &BTreeMap<String, BTreeMap<String, InterfacePort>>,
    diagnostics: &mut ProjectDiagnosticSet,
) -> DependencyAnalysis {
    let mut dependencies = BTreeMap::new();
    let mut instances: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();

    for circuit in circuits {
        let component_counts = count_ids(
            circuit
                .components
                .iter()
                .map(|component| component.id.as_str()),
        );
        let components_by_id: BTreeMap<_, _> = circuit
            .components
            .iter()
            .map(|component| (component.id.as_str(), component))
            .collect();
        let mut circuit_dependencies = BTreeSet::new();

        for component in &circuit.components {
            if component.type_id != MODULE_INSTANCE {
                continue;
            }
            let Some(module_id) = component.properties.module_id() else {
                continue;
            };
            match unique_circuits.get(module_id) {
                None => {
                    diagnostics.insert(error(
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
                }
                Some(target) if target.kind != ProjectCircuitKind::Module => {
                    diagnostics.insert(error(
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
                }
                Some(_) => {
                    circuit_dependencies.insert(module_id.to_owned());
                    instances
                        .entry((circuit.id.clone(), module_id.to_owned()))
                        .or_default()
                        .push(component.id.clone());
                }
            }
        }

        for connection in &circuit.connections {
            validate_project_connection(
                circuit,
                connection,
                &component_counts,
                &components_by_id,
                unique_circuits,
                interface_index,
                diagnostics,
            );
        }

        dependencies.insert(
            circuit.id.clone(),
            circuit_dependencies.into_iter().collect(),
        );
    }

    DependencyAnalysis {
        dependencies,
        instances,
    }
}

struct DependencyAnalysis {
    dependencies: BTreeMap<String, Vec<String>>,
    instances: BTreeMap<(String, String), Vec<String>>,
}

fn validate_project_connection(
    circuit: &ProjectCircuit,
    connection: &crate::project::ProjectConnection,
    component_counts: &BTreeMap<String, usize>,
    components: &BTreeMap<&str, &ProjectComponent>,
    unique_circuits: &BTreeMap<String, &ProjectCircuit>,
    interface_index: &BTreeMap<String, BTreeMap<String, InterfacePort>>,
    diagnostics: &mut ProjectDiagnosticSet,
) {
    let source = endpoint_component(
        &connection.source_component_id,
        component_counts,
        components,
    );
    let target = endpoint_component(
        &connection.target_component_id,
        component_counts,
        components,
    );

    if source == EndpointComponent::Missing {
        diagnostics.insert(error(
            "UNKNOWN_COMPONENT",
            format!(
                "connection '{}' references unknown source component '{}'",
                connection.id, connection.source_component_id
            ),
            &circuit.id,
            &[&connection.source_component_id],
            &[&connection.id],
            &[],
        ));
    }
    if target == EndpointComponent::Missing {
        diagnostics.insert(error(
            "UNKNOWN_COMPONENT",
            format!(
                "connection '{}' references unknown target component '{}'",
                connection.id, connection.target_component_id
            ),
            &circuit.id,
            &[&connection.target_component_id],
            &[&connection.id],
            &[],
        ));
    }

    let source_port = source.component().map(|component| {
        lookup_port(
            component,
            &connection.source_port_id,
            unique_circuits,
            interface_index,
        )
    });
    let target_port = target.component().map(|component| {
        lookup_port(
            component,
            &connection.target_port_id,
            unique_circuits,
            interface_index,
        )
    });

    if let (Some(component), Some(PortLookup::Missing)) = (source.component(), source_port) {
        diagnostics.insert(unknown_port(
            circuit,
            connection,
            component,
            &connection.source_port_id,
        ));
    }
    if let (Some(component), Some(PortLookup::Missing)) = (target.component(), target_port) {
        diagnostics.insert(unknown_port(
            circuit,
            connection,
            component,
            &connection.target_port_id,
        ));
    }

    if let (
        Some(PortLookup::Direction(source_direction)),
        Some(PortLookup::Direction(target_direction)),
    ) = (source_port, target_port)
        && (source_direction != PortDirection::Output || target_direction != PortDirection::Input)
    {
        let is_module_port = source.component().is_some_and(is_project_component)
            || target.component().is_some_and(is_project_component);
        let code = if is_module_port {
            "INVALID_MODULE_PORT_DIRECTION"
        } else {
            "INVALID_PORT_DIRECTION"
        };
        diagnostics.insert(error(
            code,
            format!(
                "connection '{}' must run from an output port to an input port",
                connection.id
            ),
            &circuit.id,
            &[
                &connection.source_component_id,
                &connection.target_component_id,
            ],
            &[&connection.id],
            &[
                (&connection.source_component_id, &connection.source_port_id),
                (&connection.target_component_id, &connection.target_port_id),
            ],
        ));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndpointComponent<'a> {
    Missing,
    Ambiguous,
    Present(&'a ProjectComponent),
}

impl<'a> EndpointComponent<'a> {
    fn component(self) -> Option<&'a ProjectComponent> {
        match self {
            Self::Present(component) => Some(component),
            Self::Missing | Self::Ambiguous => None,
        }
    }
}

fn endpoint_component<'a>(
    component_id: &str,
    component_counts: &BTreeMap<String, usize>,
    components: &BTreeMap<&str, &'a ProjectComponent>,
) -> EndpointComponent<'a> {
    match component_counts.get(component_id) {
        None => EndpointComponent::Missing,
        Some(1) => components
            .get(component_id)
            .copied()
            .map(EndpointComponent::Present)
            .unwrap_or(EndpointComponent::Missing),
        Some(_) => EndpointComponent::Ambiguous,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PortLookup {
    Direction(PortDirection),
    Missing,
    Unresolvable,
}

fn lookup_port(
    component: &ProjectComponent,
    port_id: &str,
    unique_circuits: &BTreeMap<String, &ProjectCircuit>,
    interface_index: &BTreeMap<String, BTreeMap<String, InterfacePort>>,
) -> PortLookup {
    match component.type_id.as_str() {
        MODULE_INPUT if valid_boundary_properties(component) => {
            fixed_port(port_id, "out", PortDirection::Output)
        }
        MODULE_OUTPUT if valid_boundary_properties(component) => {
            fixed_port(port_id, "in", PortDirection::Input)
        }
        MODULE_INSTANCE if valid_instance_properties(component) => {
            let Some(module_id) = component.properties.module_id() else {
                return PortLookup::Unresolvable;
            };
            if unique_circuits
                .get(module_id)
                .is_none_or(|circuit| circuit.kind != ProjectCircuitKind::Module)
            {
                return PortLookup::Unresolvable;
            }
            interface_index
                .get(module_id)
                .and_then(|ports| ports.get(port_id))
                .copied()
                .map(|port| match port {
                    InterfacePort::Direction(direction) => PortLookup::Direction(direction),
                    InterfacePort::Unresolvable | InterfacePort::Ambiguous => {
                        PortLookup::Unresolvable
                    }
                })
                .unwrap_or(PortLookup::Missing)
        }
        MODULE_INPUT | MODULE_OUTPUT | MODULE_INSTANCE => PortLookup::Unresolvable,
        type_id => {
            let Some(kind) = ComponentKind::from_type_id(type_id) else {
                return PortLookup::Unresolvable;
            };
            if !valid_builtin_properties(component, kind) {
                return PortLookup::Unresolvable;
            }
            kind.port_descriptors()
                .into_iter()
                .find(|port| port.id == port_id)
                .map(|port| PortLookup::Direction(port.direction))
                .unwrap_or(PortLookup::Missing)
        }
    }
}

fn fixed_port(port_id: &str, expected: &str, direction: PortDirection) -> PortLookup {
    if port_id == expected {
        PortLookup::Direction(direction)
    } else {
        PortLookup::Missing
    }
}

fn unknown_port(
    circuit: &ProjectCircuit,
    connection: &crate::project::ProjectConnection,
    component: &ProjectComponent,
    port_id: &str,
) -> ProjectDiagnostic {
    let code = if is_project_component(component) {
        "UNKNOWN_MODULE_PORT"
    } else {
        "UNKNOWN_PORT"
    };
    error(
        code,
        format!(
            "connection '{}' references unknown port '{}.{port_id}'",
            connection.id, component.id
        ),
        &circuit.id,
        &[&component.id],
        &[&connection.id],
        &[(&component.id, port_id)],
    )
}

fn is_project_component(component: &ProjectComponent) -> bool {
    matches!(
        component.type_id.as_str(),
        MODULE_INPUT | MODULE_OUTPUT | MODULE_INSTANCE
    )
}

fn validate_dependency_graph(
    dependencies: &BTreeMap<String, Vec<String>>,
    instances: &BTreeMap<(String, String), Vec<String>>,
    diagnostics: &mut ProjectDiagnosticSet,
) {
    let order = dependency_finishing_order(dependencies);
    let reverse = reverse_dependencies(dependencies);
    let mut assigned = BTreeSet::new();

    for circuit_id in order.into_iter().rev() {
        if assigned.contains(&circuit_id) {
            continue;
        }
        let component = collect_dependency_component(&circuit_id, &reverse, &mut assigned);
        let has_self_edge = component.len() == 1
            && dependencies
                .get(&circuit_id)
                .is_some_and(|children| children.binary_search(&circuit_id).is_ok());
        if component.len() > 1 || has_self_edge {
            let cycle = canonical_cycle(&component, dependencies);
            diagnostics.insert(dependency_cycle_error(&cycle, instances));
        }
    }
}

fn dependency_finishing_order(dependencies: &BTreeMap<String, Vec<String>>) -> Vec<String> {
    let mut visited = BTreeSet::new();
    let mut order = Vec::with_capacity(dependencies.len());

    for start in dependencies.keys() {
        if !visited.insert(start.clone()) {
            continue;
        }
        let mut stack = vec![(start.clone(), 0_usize)];
        while let Some((node, child_index)) = stack.last_mut() {
            let children = dependencies.get(node).map(Vec::as_slice).unwrap_or(&[]);
            if let Some(child) = children.get(*child_index).cloned() {
                *child_index += 1;
                if visited.insert(child.clone()) {
                    stack.push((child, 0));
                }
            } else {
                let (finished, _) = stack.pop().expect("the DFS stack is not empty");
                order.push(finished);
            }
        }
    }

    order
}

fn reverse_dependencies(
    dependencies: &BTreeMap<String, Vec<String>>,
) -> BTreeMap<String, Vec<String>> {
    let mut reverse: BTreeMap<String, Vec<String>> = dependencies
        .keys()
        .map(|circuit_id| (circuit_id.clone(), Vec::new()))
        .collect();
    for (parent, children) in dependencies {
        for child in children {
            reverse
                .entry(child.clone())
                .or_default()
                .push(parent.clone());
        }
    }
    for parents in reverse.values_mut() {
        parents.sort();
        parents.dedup();
    }
    reverse
}

fn collect_dependency_component(
    start: &str,
    reverse: &BTreeMap<String, Vec<String>>,
    assigned: &mut BTreeSet<String>,
) -> BTreeSet<String> {
    let mut component = BTreeSet::new();
    let mut stack = vec![start.to_owned()];
    assigned.insert(start.to_owned());

    while let Some(node) = stack.pop() {
        component.insert(node.clone());
        if let Some(parents) = reverse.get(&node) {
            for parent in parents.iter().rev() {
                if assigned.insert(parent.clone()) {
                    stack.push(parent.clone());
                }
            }
        }
    }

    component
}

fn canonical_cycle(
    component: &BTreeSet<String>,
    dependencies: &BTreeMap<String, Vec<String>>,
) -> Vec<String> {
    let start = component
        .first()
        .expect("a strongly connected component is not empty");
    let children = dependencies.get(start).map(Vec::as_slice).unwrap_or(&[]);

    for child in children.iter().filter(|child| component.contains(*child)) {
        if child == start {
            return vec![start.clone(), start.clone()];
        }
        if let Some(path) = dependency_path(child, start, component, dependencies) {
            let mut cycle = Vec::with_capacity(path.len() + 1);
            cycle.push(start.clone());
            cycle.extend(path);
            return cycle;
        }
    }

    unreachable!("a cyclic strongly connected component contains a cycle")
}

fn dependency_path(
    from: &str,
    to: &str,
    component: &BTreeSet<String>,
    dependencies: &BTreeMap<String, Vec<String>>,
) -> Option<Vec<String>> {
    let mut queue = VecDeque::from([from.to_owned()]);
    let mut visited = BTreeSet::from([from.to_owned()]);
    let mut parent: BTreeMap<String, String> = BTreeMap::new();

    while let Some(node) = queue.pop_front() {
        if node == to {
            let mut path = vec![node.clone()];
            let mut cursor = node;
            while let Some(previous) = parent.get(&cursor) {
                path.push(previous.clone());
                cursor = previous.clone();
            }
            path.reverse();
            return Some(path);
        }
        if let Some(children) = dependencies.get(&node) {
            for child in children {
                if component.contains(child) && visited.insert(child.clone()) {
                    parent.insert(child.clone(), node.clone());
                    queue.push_back(child.clone());
                }
            }
        }
    }

    None
}

fn dependency_cycle_error(
    cycle: &[String],
    instances: &BTreeMap<(String, String), Vec<String>>,
) -> ProjectDiagnostic {
    let mut component_refs = Vec::new();
    for edge in cycle.windows(2) {
        if let Some(component_ids) = instances.get(&(edge[0].clone(), edge[1].clone())) {
            component_refs.extend(component_ids.iter().map(|component_id| {
                QualifiedComponentRef::new(&edge[0], [] as [&str; 0], component_id)
            }));
        }
    }
    component_refs.sort();
    component_refs.dedup();
    let primary_location = component_refs
        .first()
        .cloned()
        .map(ProjectLocation::Component);

    ProjectDiagnostic {
        code: "MODULE_DEPENDENCY_CYCLE".into(),
        severity: Severity::Error,
        message: format!("module dependency cycle: {}", cycle.join(" -> ")),
        primary_location,
        component_refs,
        connection_refs: vec![],
        port_refs: vec![],
    }
}

fn count_ids<'a>(ids: impl IntoIterator<Item = &'a str>) -> BTreeMap<String, usize> {
    ids.into_iter().fold(BTreeMap::new(), |mut counts, id| {
        *counts.entry(id.to_owned()).or_default() += 1;
        counts
    })
}

fn error(
    code: &str,
    message: String,
    circuit_id: &str,
    component_ids: &[&str],
    connection_ids: &[&str],
    ports: &[(&str, &str)],
) -> ProjectDiagnostic {
    let mut component_refs: Vec<_> = component_ids
        .iter()
        .map(|component_id| QualifiedComponentRef::new(circuit_id, [] as [&str; 0], *component_id))
        .collect();
    let mut connection_refs: Vec<_> = connection_ids
        .iter()
        .map(|connection_id| {
            QualifiedConnectionRef::new(circuit_id, [] as [&str; 0], *connection_id)
        })
        .collect();
    let mut port_refs: Vec<_> = ports
        .iter()
        .map(|(component_id, port_id)| {
            QualifiedPortRef::new(circuit_id, [] as [&str; 0], *component_id, *port_id)
        })
        .collect();
    component_refs.sort();
    component_refs.dedup();
    connection_refs.sort();
    connection_refs.dedup();
    port_refs.sort();
    port_refs.dedup();
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
        code: code.to_owned(),
        severity: Severity::Error,
        message,
        primary_location,
        component_refs,
        connection_refs,
        port_refs,
    }
}
