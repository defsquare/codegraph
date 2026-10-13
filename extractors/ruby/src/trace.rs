//! What `trace/codegraph_trace.rb` wrote from inside a running program (PLAN
//! §19.5): the mixins each type has, the methods the VM holds, the calls it
//! saw. The trace names things as Ruby does — a constant path, a file and a
//! line — and never a key: the extraction finds its own entities from them.

use std::collections::HashMap;

pub const TOOL: &str = "codegraph-trace";

/// `type` has `module` among its ancestors by `how` (`include`, `extend`, `prepend`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mixin {
    pub type_name: String,
    pub how: String,
    pub module: String,
}

/// A method the VM holds for `type`, and where it says it was defined.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Method {
    pub type_name: String,
    pub name: String,
    pub singleton: bool,
    pub file: String,
    pub line: u32,
}

/// A call written at `file:line` that entered the method defined at `at:def`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Call {
    pub file: String,
    pub line: u32,
    pub name: String,
    pub at: String,
    pub def: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Trace {
    pub mixins: Vec<Mixin>,
    pub methods: Vec<Method>,
    pub calls: Vec<Call>,
}

#[derive(Debug, PartialEq)]
enum Value {
    Text(String),
    Number(u32),
    Flag(bool),
    Other,
}

/// Reads one flat JSON object — all a trace record is.
fn object(line: &str) -> Result<HashMap<String, Value>, String> {
    let mut chars = line.trim().chars().peekable();
    let mut out = HashMap::new();
    let expect = |chars: &mut std::iter::Peekable<std::str::Chars<'_>>, wanted: char| match chars.next() {
        Some(found) if found == wanted => Ok(()),
        found => Err(format!("expected `{wanted}`, found {found:?}")),
    };
    let skip = |chars: &mut std::iter::Peekable<std::str::Chars<'_>>| {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
    };
    expect(&mut chars, '{')?;
    skip(&mut chars);
    if chars.peek() == Some(&'}') {
        return Ok(out);
    }
    loop {
        skip(&mut chars);
        let key = string(&mut chars)?;
        skip(&mut chars);
        expect(&mut chars, ':')?;
        skip(&mut chars);
        let value = match chars.peek() {
            Some('"') => Value::Text(string(&mut chars)?),
            Some(c) if c.is_ascii_digit() => {
                let mut digits = String::new();
                while let Some(digit) = chars.peek().filter(|c| c.is_ascii_digit()) {
                    digits.push(*digit);
                    chars.next();
                }
                digits.parse().map(Value::Number).unwrap_or(Value::Other)
            }
            _ => {
                let mut word = String::new();
                while let Some(letter) = chars.peek().filter(|c| c.is_ascii_alphabetic()) {
                    word.push(*letter);
                    chars.next();
                }
                match word.as_str() {
                    "true" => Value::Flag(true),
                    "false" => Value::Flag(false),
                    "null" => Value::Other,
                    _ => return Err(format!("unreadable value for `{key}`")),
                }
            }
        };
        out.insert(key, value);
        skip(&mut chars);
        match chars.next() {
            Some(',') => continue,
            Some('}') => return Ok(out),
            found => return Err(format!("expected `,` or `}}`, found {found:?}")),
        }
    }
}

fn string(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> Result<String, String> {
    if chars.next() != Some('"') {
        return Err("expected a string".to_owned());
    }
    let mut out = String::new();
    let mut units: Vec<u16> = Vec::new();
    // `😀`: two escapes, one character.
    let flush = |units: &mut Vec<u16>, out: &mut String| {
        if !units.is_empty() {
            out.push_str(&String::from_utf16_lossy(units));
            units.clear();
        }
    };
    loop {
        let Some(c) = chars.next() else {
            return Err("unterminated string".to_owned());
        };
        if c != '\\' {
            flush(&mut units, &mut out);
            if c == '"' {
                return Ok(out);
            }
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                units.push(u16::from_str_radix(&hex, 16).map_err(|_| format!("bad escape \\u{hex}"))?);
                continue;
            }
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some(other @ ('"' | '\\' | '/')) => out.push(other),
            other => return Err(format!("bad escape {other:?}")),
        }
        flush(&mut units, &mut out);
    }
}

fn text(record: &HashMap<String, Value>, key: &str) -> Result<String, String> {
    match record.get(key) {
        Some(Value::Text(text)) => Ok(text.clone()),
        _ => Err(format!("`{key}` must be a string")),
    }
}

fn number(record: &HashMap<String, Value>, key: &str) -> Result<u32, String> {
    match record.get(key) {
        Some(Value::Number(number)) => Ok(*number),
        _ => Err(format!("`{key}` must be a line number")),
    }
}

/// Reads a trace. The first record must be the tool's header; a record of a
/// type this version does not know is skipped, a malformed one is an error.
pub fn parse(source: &str) -> Result<Trace, String> {
    let mut trace = Trace::default();
    let mut lines = source.lines().enumerate().filter(|(_, line)| !line.trim().is_empty());
    let header = lines
        .next()
        .and_then(|(_, line)| object(line).ok())
        .filter(|header| header.get("t") == Some(&Value::Text("header".to_owned())));
    match header.as_ref().and_then(|header| header.get("tool")) {
        Some(Value::Text(tool)) if tool == TOOL => {}
        _ => return Err(format!("not a trace: the first line is not a `{TOOL}` header")),
    }
    for (index, line) in lines {
        let read = |line: &str| -> Result<(), String> {
            let record = object(line)?;
            match text(&record, "t")?.as_str() {
                "mixin" => trace.mixins.push(Mixin {
                    type_name: text(&record, "type")?,
                    how: text(&record, "how")?,
                    module: text(&record, "module")?,
                }),
                "method" => trace.methods.push(Method {
                    type_name: text(&record, "type")?,
                    name: text(&record, "name")?,
                    singleton: record.get("singleton") == Some(&Value::Flag(true)),
                    file: text(&record, "file")?,
                    line: number(&record, "line")?,
                }),
                "call" => trace.calls.push(Call {
                    file: text(&record, "file")?,
                    line: number(&record, "line")?,
                    name: text(&record, "name")?,
                    at: text(&record, "at")?,
                    def: number(&record, "def")?,
                }),
                _ => {}
            }
            Ok(())
        };
        let mut read = read;
        read(line).map_err(|message| format!("line {}: {message}", index + 1))?;
    }
    Ok(trace)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = r#"{"t":"header","tool":"codegraph-trace","version":"0.1.0","ruby":"3.4.11","root":"/work"}"#;

    #[test]
    fn reads_the_three_records_and_skips_what_it_does_not_know() {
        let trace = parse(&format!(
            "{HEADER}\n{}\n{}\n{}\n{}\n{}\n",
            r#"{"t":"mixin","type":"Acme::Order","how":"extend","module":"Acme::Finder::ClassMethods"}"#,
            r#"{"t":"method","type":"Acme::Order","name":"total=","singleton":false,"file":"lib/acme/order.rb","line":12}"#,
            r#"{"t":"call","file":"lib/a.rb","line":3,"name":"total","at":"lib/acme/order.rb","def":12}"#,
            r#"{"t":"later","anything":null}"#,
            r#"{"t":"eof","mixins":1,"methods":1,"calls":1}"#,
        ))
        .unwrap();
        assert_eq!(
            trace.mixins,
            vec![Mixin {
                type_name: "Acme::Order".into(),
                how: "extend".into(),
                module: "Acme::Finder::ClassMethods".into()
            }]
        );
        assert_eq!(
            trace.methods,
            vec![Method {
                type_name: "Acme::Order".into(),
                name: "total=".into(),
                singleton: false,
                file: "lib/acme/order.rb".into(),
                line: 12
            }]
        );
        assert_eq!(
            trace.calls,
            vec![Call {
                file: "lib/a.rb".into(),
                line: 3,
                name: "total".into(),
                at: "lib/acme/order.rb".into(),
                def: 12
            }]
        );
    }

    #[test]
    fn reads_the_escapes_json_writes() {
        let trace = parse(&format!(
            "{HEADER}\n{}\n",
            r#"{"t":"method","type":"A","name":"café 😀 \"q\" \\ \/","singleton":true,"file":"lib/promo#2024.rb","line":1}"#,
        ))
        .unwrap();
        assert_eq!(trace.methods[0].name, "café 😀 \"q\" \\ /");
        assert!(trace.methods[0].singleton);
    }

    #[test]
    fn refuses_what_is_not_a_trace_and_says_which_line_is_malformed() {
        assert_eq!(
            parse("{\"t\":\"e\",\"i\":0}\n").unwrap_err(),
            "not a trace: the first line is not a `codegraph-trace` header"
        );
        assert_eq!(
            parse("").unwrap_err(),
            "not a trace: the first line is not a `codegraph-trace` header"
        );
        let broken = format!("{HEADER}\n{}\n", r#"{"t":"call","file":"a.rb","line":"three"}"#);
        assert_eq!(parse(&broken).unwrap_err(), "line 2: `line` must be a line number");
        let cut = format!("{HEADER}\n{}\n", r#"{"t":"mixin","type":"A""#);
        assert!(parse(&cut).unwrap_err().starts_with("line 2: "));
    }
}
