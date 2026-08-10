use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::diagnostic::Severity;
use crate::trit::Trit;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocument {
    pub format: String,
    pub version: u32,
    pub root_circuit_id: String,
    pub circuits: Vec<ProjectCircuit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectCircuitKind {
    Main,
    Module,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCircuit {
    pub id: String,
    pub name: String,
    pub kind: ProjectCircuitKind,
    pub components: Vec<ProjectComponent>,
    pub connections: Vec<ProjectConnection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectDocumentV3 {
    pub format: String,
    pub version: u32,
    pub root_circuit_id: String,
    pub circuits: Vec<ProjectCircuitV3>,
}

impl ProjectDocumentV3 {
    pub fn parse_json(json: &str) -> Result<Self, ProjectDocumentV3ParseError> {
        #[derive(Deserialize)]
        struct VersionHeader {
            version: u32,
        }

        let header: VersionHeader = serde_json::from_str(json)?;
        if header.version != 3 {
            return Err(ProjectDocumentV3ParseError::UnsupportedVersion(
                header.version,
            ));
        }
        Ok(serde_json::from_str(json)?)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCircuitV3 {
    pub id: String,
    pub name: String,
    pub kind: ProjectCircuitKind,
    pub components: Vec<ProjectComponent>,
    pub wires: Vec<ProjectWire>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectWire {
    pub id: String,
    pub endpoint_a: WireEndpoint,
    pub endpoint_b: WireEndpoint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WireEndpoint {
    pub component_id: String,
    pub port_id: String,
}

#[derive(Debug, Error)]
pub enum ProjectDocumentV3ParseError {
    #[error("unsupported project document version {0}; expected version 3")]
    UnsupportedVersion(u32),
    #[error("invalid project v3 JSON: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectComponent {
    pub id: String,
    pub type_id: String,
    pub properties: ProjectProperties,
}

impl ProjectComponent {
    pub fn new(
        id: impl Into<String>,
        type_id: impl Into<String>,
        properties: Value,
    ) -> Result<Self, ProjectContractError> {
        Ok(Self {
            id: id.into(),
            type_id: type_id.into(),
            properties: ProjectProperties::from_value(properties)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConnection {
    pub id: String,
    pub source_component_id: String,
    pub source_port_id: String,
    pub target_component_id: String,
    pub target_port_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectProperties(Map<String, Value>);

impl ProjectProperties {
    pub fn from_value(value: Value) -> Result<Self, ProjectContractError> {
        match value {
            Value::Object(properties) => Ok(Self(properties)),
            _ => Err(ProjectContractError::PropertiesMustBeObject),
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.keys().map(String::as_str)
    }

    pub fn known_value(&self) -> Option<Trit> {
        self.known_trit("value")
    }

    pub fn module_id(&self) -> Option<&str> {
        self.string("moduleId")
    }

    pub fn port_id(&self) -> Option<&str> {
        self.string("portId")
    }

    pub fn label(&self) -> Option<&str> {
        self.string("label")
    }

    pub fn preview_value(&self) -> Option<Trit> {
        self.known_trit("previewValue")
    }

    pub fn set_known_value(&mut self, key: &str, value: Trit) {
        let symbol = match value {
            Trit::Neg => "T",
            Trit::Zero => "0",
            Trit::Pos => "1",
            Trit::Unknown | Trit::HighZ | Trit::Error => {
                debug_assert!(false, "project source values must be known");
                return;
            }
        };
        self.0.insert(key.to_owned(), Value::String(symbol.into()));
    }

    fn string(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    fn known_trit(&self, key: &str) -> Option<Trit> {
        let value = self.string(key)?;
        match value {
            "T" => Some(Trit::Neg),
            "0" => Some(Trit::Zero),
            "1" => Some(Trit::Pos),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProjectContractError {
    #[error("project component properties must be an object")]
    PropertiesMustBeObject,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualifiedComponentRef {
    pub circuit_id: String,
    pub instance_path: Vec<String>,
    pub component_id: String,
}

impl QualifiedComponentRef {
    pub fn new<I, S>(
        circuit_id: impl Into<String>,
        instance_path: I,
        component_id: impl Into<String>,
    ) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            circuit_id: circuit_id.into(),
            instance_path: instance_path.into_iter().map(Into::into).collect(),
            component_id: component_id.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualifiedConnectionRef {
    pub circuit_id: String,
    pub instance_path: Vec<String>,
    pub connection_id: String,
}

impl QualifiedConnectionRef {
    pub fn new<I, S>(
        circuit_id: impl Into<String>,
        instance_path: I,
        connection_id: impl Into<String>,
    ) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            circuit_id: circuit_id.into(),
            instance_path: instance_path.into_iter().map(Into::into).collect(),
            connection_id: connection_id.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualifiedPortRef {
    pub circuit_id: String,
    pub instance_path: Vec<String>,
    pub component_id: String,
    pub port_id: String,
}

impl QualifiedPortRef {
    pub fn new<I, S>(
        circuit_id: impl Into<String>,
        instance_path: I,
        component_id: impl Into<String>,
        port_id: impl Into<String>,
    ) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            circuit_id: circuit_id.into(),
            instance_path: instance_path.into_iter().map(Into::into).collect(),
            component_id: component_id.into(),
            port_id: port_id.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "ref", rename_all = "snake_case")]
pub enum ProjectLocation {
    Component(QualifiedComponentRef),
    Connection(QualifiedConnectionRef),
    Port(QualifiedPortRef),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiagnostic {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    pub primary_location: Option<ProjectLocation>,
    pub component_refs: Vec<QualifiedComponentRef>,
    pub connection_refs: Vec<QualifiedConnectionRef>,
    pub port_refs: Vec<QualifiedPortRef>,
}

impl ProjectDiagnostic {
    pub fn dedup_key(&self) -> ProjectDiagnosticKey {
        let mut component_refs = self.component_refs.clone();
        let mut connection_refs = self.connection_refs.clone();
        let mut port_refs = self.port_refs.clone();
        component_refs.sort();
        component_refs.dedup();
        connection_refs.sort();
        connection_refs.dedup();
        port_refs.sort();
        port_refs.dedup();
        let location = diagnostic_location(&component_refs, &connection_refs, &port_refs);

        ProjectDiagnosticKey {
            location,
            code: self.code.clone(),
            severity: self.severity,
            component_refs,
            connection_refs,
            port_refs,
        }
    }

    fn normalize_refs(&mut self) {
        self.component_refs.sort();
        self.component_refs.dedup();
        self.connection_refs.sort();
        self.connection_refs.dedup();
        self.port_refs.sort();
        self.port_refs.dedup();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProjectDiagnosticKey {
    location: Option<ProjectDiagnosticLocationKey>,
    code: String,
    severity: Severity,
    component_refs: Vec<QualifiedComponentRef>,
    connection_refs: Vec<QualifiedConnectionRef>,
    port_refs: Vec<QualifiedPortRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct ProjectDiagnosticLocationKey {
    circuit_id: String,
    instance_path: Vec<String>,
    target: ProjectDiagnosticLocationTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum ProjectDiagnosticLocationTarget {
    Port {
        component_id: String,
        port_id: String,
    },
    Component {
        component_id: String,
    },
    Connection {
        connection_id: String,
    },
}

fn diagnostic_location(
    component_refs: &[QualifiedComponentRef],
    connection_refs: &[QualifiedConnectionRef],
    port_refs: &[QualifiedPortRef],
) -> Option<ProjectDiagnosticLocationKey> {
    let ports = port_refs
        .iter()
        .map(|reference| ProjectDiagnosticLocationKey {
            circuit_id: reference.circuit_id.clone(),
            instance_path: reference.instance_path.clone(),
            target: ProjectDiagnosticLocationTarget::Port {
                component_id: reference.component_id.clone(),
                port_id: reference.port_id.clone(),
            },
        });
    let components = component_refs
        .iter()
        .map(|reference| ProjectDiagnosticLocationKey {
            circuit_id: reference.circuit_id.clone(),
            instance_path: reference.instance_path.clone(),
            target: ProjectDiagnosticLocationTarget::Component {
                component_id: reference.component_id.clone(),
            },
        });
    let connections = connection_refs
        .iter()
        .map(|reference| ProjectDiagnosticLocationKey {
            circuit_id: reference.circuit_id.clone(),
            instance_path: reference.instance_path.clone(),
            target: ProjectDiagnosticLocationTarget::Connection {
                connection_id: reference.connection_id.clone(),
            },
        });

    ports.chain(components).chain(connections).min()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectDiagnosticSet {
    diagnostics: BTreeMap<ProjectDiagnosticKey, ProjectDiagnostic>,
}

impl ProjectDiagnosticSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, mut diagnostic: ProjectDiagnostic) -> bool {
        diagnostic.normalize_refs();
        let key = diagnostic.dedup_key();

        match self.diagnostics.entry(key) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(diagnostic);
                true
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                if presentation_key(&diagnostic) < presentation_key(entry.get()) {
                    entry.insert(diagnostic);
                }
                false
            }
        }
    }

    pub fn into_vec(self) -> Vec<ProjectDiagnostic> {
        self.diagnostics.into_values().collect()
    }
}

fn presentation_key(diagnostic: &ProjectDiagnostic) -> (bool, Option<&ProjectLocation>, &str) {
    (
        diagnostic.primary_location.is_none(),
        diagnostic.primary_location.as_ref(),
        &diagnostic.message,
    )
}
