use crate::trit::Trit;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodedAddress {
    Known(usize),
    Unknown,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnsafeRamWrite {
    Reset,
    WriteEnable,
    Address,
}

pub fn decode_balanced_address(bits_ms_first: &[Trit], width: u8) -> DecodedAddress {
    if !(1..=3).contains(&width) || bits_ms_first.len() < usize::from(width) {
        return DecodedAddress::Error;
    }

    let bits = &bits_ms_first[..usize::from(width)];
    if bits.contains(&Trit::Error) {
        return DecodedAddress::Error;
    }
    if bits
        .iter()
        .any(|bit| matches!(bit, Trit::Unknown | Trit::HighZ))
    {
        return DecodedAddress::Unknown;
    }

    let balanced_value = bits.iter().fold(0_i16, |value, bit| {
        value * 3 + i16::from(bit.balanced_value().expect("known address trit"))
    });
    let depth = depth_for_address_width(width).expect("validated address width");
    let bias = i16::try_from((depth - 1) / 2).expect("memory depth fits i16");
    DecodedAddress::Known(
        usize::try_from(balanced_value + bias).expect("biased address is non-negative"),
    )
}

pub(crate) const fn depth_for_address_width(width: u8) -> Option<usize> {
    match width {
        1 => Some(3),
        2 => Some(9),
        3 => Some(27),
        _ => None,
    }
}

pub(crate) fn read_cell(contents: &[Trit], address: DecodedAddress) -> Trit {
    match address {
        DecodedAddress::Known(index) => contents.get(index).copied().unwrap_or(Trit::Zero),
        DecodedAddress::Unknown => Trit::Unknown,
        DecodedAddress::Error => Trit::Error,
    }
}

pub(crate) fn ram_next_state(
    current: &[Trit],
    address: DecodedAddress,
    data: Trit,
    write_enable: Trit,
    reset: Trit,
) -> Result<Vec<Trit>, UnsafeRamWrite> {
    match reset {
        Trit::Pos => return Ok(vec![Trit::Zero; current.len()]),
        Trit::Neg | Trit::Zero => {}
        Trit::Unknown | Trit::HighZ | Trit::Error => return Err(UnsafeRamWrite::Reset),
    }

    match write_enable {
        Trit::Neg | Trit::Zero => Ok(current.to_vec()),
        Trit::Pos => match address {
            DecodedAddress::Known(index) => {
                let mut next = current.to_vec();
                next[index] = data;
                Ok(next)
            }
            DecodedAddress::Unknown | DecodedAddress::Error => Err(UnsafeRamWrite::Address),
        },
        Trit::Unknown | Trit::HighZ | Trit::Error => Err(UnsafeRamWrite::WriteEnable),
    }
}
