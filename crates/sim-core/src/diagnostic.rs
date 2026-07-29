use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

pub type DiagnosticSeverity = Severity;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    pub component_ids: Vec<String>,
    pub connection_ids: Vec<String>,
    pub port_ids: Vec<String>,
}

impl Diagnostic {
    pub(crate) fn error(
        code: &str,
        message: String,
        component_ids: Vec<String>,
        connection_ids: Vec<String>,
        port_ids: Vec<String>,
    ) -> Self {
        Self {
            code: code.to_owned(),
            severity: Severity::Error,
            message,
            component_ids,
            connection_ids,
            port_ids,
        }
    }

    pub(crate) fn warning(
        code: &str,
        message: String,
        component_ids: Vec<String>,
        connection_ids: Vec<String>,
        port_ids: Vec<String>,
    ) -> Self {
        Self {
            code: code.to_owned(),
            severity: Severity::Warning,
            message,
            component_ids,
            connection_ids,
            port_ids,
        }
    }
}
