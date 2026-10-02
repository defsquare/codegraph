//! Numbers spelled the way core's encoder spells them.
//!
//! The model is written by `JSON.stringify` (or a byte-identical twin), so a
//! value this binary adds must be the digits JavaScript's `Number::toString`
//! produces: `3` not `3.0`, `1e+21` not `1e21`, `1e-7` not `0.0000001`.

/// Decimal places a measure keeps. `ln`/`log2` may differ in the last ulp
/// between platforms' libm; rounding keeps the bytes equal on every OS.
const DECIMALS: f64 = 10_000.0;

/// `value` rounded to four decimal places, `None` when it is not finite —
/// bca's NaN means "not applicable", which the model spells as absence.
pub fn measure(value: f64) -> Option<String> {
    if !value.is_finite() {
        return None;
    }
    let rounded = (value * DECIMALS).round() / DECIMALS;
    Some(js_number(if rounded == 0.0 { 0.0 } else { rounded }))
}

/// ECMAScript `Number::toString(x)` for a finite `x` (ECMA-262 §6.1.6.1.20).
fn js_number(x: f64) -> String {
    if x == 0.0 {
        return "0".to_owned();
    }
    // `{:e}` is the shortest round-trip digit string, which is the `s` the
    // specification asks for: "d.ddde±n" → digits and exponent.
    let sci = format!("{:e}", x.abs());
    let (mantissa, exponent) = sci.split_once('e').expect("{:e} always writes an exponent");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exponent: i32 = exponent.parse().expect("{:e} writes an integer exponent");
    let k = i32::try_from(digits.len()).expect("a double has at most 17 significant digits");
    let n = exponent + 1;
    let sign = if x < 0.0 { "-" } else { "" };
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let (int, frac) = digits.split_at(n as usize);
        format!("{int}.{frac}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e_sign = if e < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        let dotted = if rest.is_empty() {
            first.to_owned()
        } else {
            format!("{first}.{rest}")
        };
        format!("{dotted}e{e_sign}{}", e.abs())
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use super::{js_number, measure};

    // Every expectation below is what `String(x)` / `JSON.stringify(x)` prints in Node.
    #[test]
    fn spells_numbers_like_javascript() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (3.0, "3"),
            (-3.0, "-3"),
            (1.5, "1.5"),
            (0.1, "0.1"),
            (123.456, "123.456"),
            (100.0, "100"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1_152_921_504_606_846_976.0, "1152921504606847000"),
            (0.000_001, "0.000001"),
            (0.000_000_1, "1e-7"),
            (1.25e-7, "1.25e-7"),
            (0.3 + 0.6, "0.8999999999999999"),
        ];
        for &(value, expected) in cases {
            assert_eq!(js_number(value), expected, "{value:e}");
        }
    }

    #[test]
    fn rounds_to_four_decimals_and_drops_non_finite() {
        assert_eq!(measure(1.234_567_89).as_deref(), Some("1.2346"));
        assert_eq!(measure(4.0).as_deref(), Some("4"));
        assert_eq!(measure(0.000_04).as_deref(), Some("0"));
        assert_eq!(measure(-0.000_04).as_deref(), Some("0"));
        assert_eq!(measure(f64::NAN), None);
        assert_eq!(measure(f64::INFINITY), None);
    }
}
