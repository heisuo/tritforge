use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::project::{ProjectDiagnostic, QualifiedPortRef};
use crate::signal::WordValue;
use crate::simulator::ClockPhase;

pub const TRACE_CAPACITY: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TraceFrameReason {
    Load,
    InputChange,
    ClockRise,
    ClockFall,
    Reset,
    Fault,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "ref", rename_all = "camelCase")]
pub enum TraceSignalRef {
    ComponentPort(QualifiedPortRef),
}

impl TraceSignalRef {
    pub const fn port(&self) -> &QualifiedPortRef {
        match self {
            Self::ComponentPort(reference) => reference,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceWatch {
    pub id: String,
    pub signal: TraceSignalRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceValue {
    pub watch_id: String,
    pub value: WordValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceFrame {
    pub cycle: u64,
    pub clock_phase: ClockPhase,
    pub reason: TraceFrameReason,
    pub values: Vec<TraceValue>,
    pub diagnostics: Vec<ProjectDiagnostic>,
}

#[derive(Debug, Default)]
pub struct TraceRecorder {
    watches: Vec<TraceWatch>,
    frames: VecDeque<TraceFrame>,
}

impl TraceRecorder {
    pub fn watches(&self) -> &[TraceWatch] {
        &self.watches
    }

    pub fn frames(&self) -> &VecDeque<TraceFrame> {
        &self.frames
    }

    pub fn clear(&mut self) {
        self.frames.clear();
    }

    pub(crate) fn replace_watches(&mut self, watches: Vec<TraceWatch>) {
        self.watches = watches;
        self.frames.clear();
    }

    pub(crate) fn push(&mut self, frame: TraceFrame) {
        if self.frames.len() == TRACE_CAPACITY {
            self.frames.pop_front();
        }
        self.frames.push_back(frame);
    }

    pub(crate) fn is_active(&self) -> bool {
        !self.watches.is_empty()
    }

    pub(crate) fn last_frame(&self) -> Option<&TraceFrame> {
        self.frames.back()
    }
}
