use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::hierarchy::FlatPortRef;
use crate::project::{ProjectDiagnostic, QualifiedPortRef};
use crate::signal::{SignalShape, WordValue};
use crate::simulator::ClockPhase;

pub const TRACE_CAPACITY: usize = 512;
/// Maximum number of independently selected signals retained by one recorder.
pub const MAX_TRACE_WATCHES: usize = 64;

/// Lightweight counters used to verify trace work stays proportional to selected signals.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TracePerformanceCounters {
    /// Full public project snapshots materialized by the simulator.
    pub project_snapshot_projections: u64,
    /// Intermediate flat phase snapshots captured exclusively for tracing.
    pub phase_snapshot_captures: u64,
    /// Watch endpoint indexes built during trace lifecycle changes.
    pub binding_index_builds: u64,
    /// Flat component provenance entries indexed while resolving watches.
    pub binding_component_entries: u64,
    /// Watches resolved into cached bindings.
    pub binding_resolutions: u64,
    /// Cached flat endpoints read while recording frames.
    pub endpoint_reads: u64,
}

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

#[derive(Debug, Clone)]
pub(crate) struct TraceBinding {
    pub watch_id: String,
    pub shape: SignalShape,
    pub bits: Vec<Vec<FlatPortRef>>,
}

#[derive(Debug, Default)]
pub struct TraceRecorder {
    watches: Vec<TraceWatch>,
    bindings: Vec<TraceBinding>,
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

    pub(crate) fn replace_watches(
        &mut self,
        watches: Vec<TraceWatch>,
        bindings: Vec<TraceBinding>,
    ) {
        debug_assert_eq!(watches.len(), bindings.len());
        self.watches = watches;
        self.bindings = bindings;
        self.frames.clear();
    }

    pub(crate) fn bindings(&self) -> &[TraceBinding] {
        &self.bindings
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
