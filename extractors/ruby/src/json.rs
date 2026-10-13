//! The bytes `JSON.stringify` writes, for the value shapes a record holds.
//! Key order is the caller's: the order IS the contract (schemas/README.md).

/// Appends `text` as a JSON string, escaped exactly as V8 does: `"`, `\` and
/// control characters (the short escapes, else `\u00xx` in lowercase hex);
/// `/`, U+007F, U+2028 and everything non-ASCII stay raw.
pub fn string(out: &mut String, text: &str) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                let code = c as usize;
                out.push_str("\\u00");
                out.push(HEX[code >> 4] as char);
                out.push(HEX[code & 0xf] as char);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Appends `"key":` — the caller writes the value next.
pub fn key(out: &mut String, name: &str) {
    string(out, name);
    out.push(':');
}

/// Appends a JSON array of strings.
pub fn strings<'a>(out: &mut String, items: impl IntoIterator<Item = &'a str>) {
    out.push('[');
    for (index, item) in items.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        string(out, item);
    }
    out.push(']');
}

/// Appends a JSON array of integers.
pub fn integers(out: &mut String, items: impl IntoIterator<Item = usize>) {
    out.push('[');
    for (index, item) in items.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&item.to_string());
    }
    out.push(']');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(text: &str) -> String {
        let mut out = String::new();
        string(&mut out, text);
        out
    }

    #[test]
    fn escapes_what_json_stringify_escapes_and_nothing_else() {
        assert_eq!(encoded("a\"b\\c"), r#""a\"b\\c""#);
        assert_eq!(encoded("\u{08}\u{0c}\n\r\t"), r#""\b\f\n\r\t""#);
        assert_eq!(encoded("\u{00}\u{1f}\u{0b}"), r#""\u0000\u001f\u000b""#);
        // The characters JS and other encoders disagree on by default: all raw.
        assert_eq!(encoded("a/b"), "\"a/b\"");
        assert_eq!(encoded("\u{7f}"), "\"\u{7f}\"");
        assert_eq!(encoded("\u{2028}\u{2029}"), "\"\u{2028}\u{2029}\"");
        assert_eq!(encoded("café 😀"), "\"café 😀\"");
    }

    #[test]
    fn writes_arrays_without_spaces() {
        let mut out = String::new();
        strings(&mut out, ["a", "b"]);
        integers(&mut out, [0, 12]);
        assert_eq!(out, r#"["a","b"][0,12]"#);
    }
}
