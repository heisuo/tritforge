use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Trit {
    #[serde(rename = "T")]
    Neg,
    #[serde(rename = "0")]
    Zero,
    #[serde(rename = "1")]
    Pos,
    #[serde(rename = "X")]
    Unknown,
    #[serde(rename = "Z")]
    HighZ,
    #[serde(rename = "E")]
    Error,
}

impl Trit {
    pub const fn is_known(self) -> bool {
        matches!(self, Self::Neg | Self::Zero | Self::Pos)
    }

    pub const fn balanced_value(self) -> Option<i8> {
        match self {
            Self::Neg => Some(-1),
            Self::Zero => Some(0),
            Self::Pos => Some(1),
            _ => None,
        }
    }

    pub const fn normalize_gate_input(self) -> Self {
        match self {
            Self::HighZ => Self::Unknown,
            other => other,
        }
    }
}

pub fn resolve_drivers(drivers: &[Trit]) -> Trit {
    if drivers.contains(&Trit::Error) {
        return Trit::Error;
    }

    let mut known = [false; 3];
    let mut has_unknown = false;

    for driver in drivers {
        match driver {
            Trit::Neg => known[0] = true,
            Trit::Zero => known[1] = true,
            Trit::Pos => known[2] = true,
            Trit::Unknown => has_unknown = true,
            Trit::HighZ => {}
            Trit::Error => unreachable!(),
        }
    }

    if known.iter().filter(|present| **present).count() > 1 {
        Trit::Error
    } else if has_unknown {
        Trit::Unknown
    } else if known[0] {
        Trit::Neg
    } else if known[1] {
        Trit::Zero
    } else if known[2] {
        Trit::Pos
    } else {
        Trit::HighZ
    }
}
