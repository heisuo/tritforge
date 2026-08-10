use std::fmt;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

use crate::trit::Trit;

const MIN_WIDTH: u8 = 1;
const MAX_WIDTH: u8 = 27;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SignalError {
    #[error("signal width must be between 1 and 27, got {width}")]
    InvalidWidth { width: usize },
    #[error("signal width is {expected}, but value contains {actual} trits")]
    WidthMismatch { expected: u8, actual: usize },
    #[error("invalid ternary symbol '{symbol}'")]
    InvalidSymbol { symbol: char },
    #[error("known ternary value exceeds its numeric representation")]
    ValueOverflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SignalShape(u8);

impl SignalShape {
    pub fn new(width: u8) -> Result<Self, SignalError> {
        if (MIN_WIDTH..=MAX_WIDTH).contains(&width) {
            Ok(Self(width))
        } else {
            Err(SignalError::InvalidWidth {
                width: usize::from(width),
            })
        }
    }

    pub const fn width(self) -> u8 {
        self.0
    }

    fn from_len(width: usize) -> Result<Self, SignalError> {
        if width > usize::from(MAX_WIDTH) {
            return Err(SignalError::InvalidWidth { width });
        }

        Self::new(width as u8)
    }
}

impl Serialize for SignalShape {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(self.0)
    }
}

impl<'de> Deserialize<'de> for SignalShape {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let width = u8::deserialize(deserializer)?;
        Self::new(width).map_err(D::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct KnownWord {
    shape: SignalShape,
    trits: Box<[Trit]>,
    balanced_value: i64,
}

impl KnownWord {
    pub fn parse(value: &str, shape: SignalShape) -> Result<Self, SignalError> {
        let mut trits = Vec::with_capacity(usize::from(shape.width()));
        let mut balanced_value = 0_i64;

        for symbol in value.chars() {
            let (trit, digit) = parse_known_trit(symbol)?;
            balanced_value = balanced_value
                .checked_mul(3)
                .and_then(|value| value.checked_add(digit))
                .ok_or(SignalError::ValueOverflow)?;
            trits.push(trit);
        }

        check_width(shape, trits.len())?;
        trits.reverse();

        Ok(Self {
            shape,
            trits: trits.into_boxed_slice(),
            balanced_value,
        })
    }

    pub const fn shape(&self) -> SignalShape {
        self.shape
    }

    pub fn trit(&self, index: u8) -> Trit {
        self.trits[usize::from(index)]
    }

    pub const fn balanced_value(&self) -> i64 {
        self.balanced_value
    }
}

impl fmt::Display for KnownWord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_ms_first(&self.trits, formatter)
    }
}

impl Serialize for KnownWord {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for KnownWord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let shape = SignalShape::from_len(value.chars().count()).map_err(D::Error::custom)?;
        Self::parse(&value, shape).map_err(D::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WordValue {
    shape: SignalShape,
    trits: Vec<Trit>,
}

impl WordValue {
    pub fn new(shape: SignalShape, trits: Vec<Trit>) -> Result<Self, SignalError> {
        check_width(shape, trits.len())?;
        Ok(Self { shape, trits })
    }

    pub const fn shape(&self) -> SignalShape {
        self.shape
    }

    pub fn trit(&self, index: u8) -> Trit {
        self.trits[usize::from(index)]
    }
}

impl fmt::Display for WordValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_ms_first(&self.trits, formatter)
    }
}

impl Serialize for WordValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for WordValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let shape = SignalShape::from_len(value.chars().count()).map_err(D::Error::custom)?;
        let trits = value
            .chars()
            .rev()
            .map(parse_runtime_trit)
            .collect::<Result<Vec<_>, _>>()
            .map_err(D::Error::custom)?;
        Self::new(shape, trits).map_err(D::Error::custom)
    }
}

fn check_width(shape: SignalShape, actual: usize) -> Result<(), SignalError> {
    if usize::from(shape.width()) == actual {
        Ok(())
    } else {
        Err(SignalError::WidthMismatch {
            expected: shape.width(),
            actual,
        })
    }
}

fn parse_known_trit(symbol: char) -> Result<(Trit, i64), SignalError> {
    match symbol {
        'T' => Ok((Trit::Neg, -1)),
        '0' => Ok((Trit::Zero, 0)),
        '1' => Ok((Trit::Pos, 1)),
        _ => Err(SignalError::InvalidSymbol { symbol }),
    }
}

fn parse_runtime_trit(symbol: char) -> Result<Trit, SignalError> {
    match symbol {
        'T' => Ok(Trit::Neg),
        '0' => Ok(Trit::Zero),
        '1' => Ok(Trit::Pos),
        'X' => Ok(Trit::Unknown),
        'Z' => Ok(Trit::HighZ),
        'E' => Ok(Trit::Error),
        _ => Err(SignalError::InvalidSymbol { symbol }),
    }
}

fn write_ms_first(trits: &[Trit], formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    for trit in trits.iter().rev() {
        formatter.write_str(match trit {
            Trit::Neg => "T",
            Trit::Zero => "0",
            Trit::Pos => "1",
            Trit::Unknown => "X",
            Trit::HighZ => "Z",
            Trit::Error => "E",
        })?;
    }
    Ok(())
}
