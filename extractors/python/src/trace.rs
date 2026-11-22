//! What `trace/codegraph_trace.py` wrote from inside a running program (PLAN
//! §23.5): the bases each class holds, the functions the interpreter holds,
//! the calls it saw. The trace names things as Python does — a module, a
//! `__qualname__`, a file and a line — and never a key: the extraction finds
//! its own entities from them. The reader is the Ruby extractor's: a record is
//! one flat JSON object.

use std::collections::HashMap;

pub const TOOL: &str = "codegraph-trace";

/// The `index`-th of `__bases__` of the class `class` (a `__qualname__`) whose module is `file`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Base {
    pub file: String,
    pub class: String,
    pub index: u32,
    /// The base's `__module__` and `__qualname__`.
    pub module: String,
    pub name: String,
    /// The file of the base's module, when it is below the root.
    pub at: Option<String>,
}

/// A function the interpreter holds whose code starts on `line` of `file`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Function {
    pub file: String,
    pub line: u32,
    pub name: String,
}

/// A call written at `file:line` that entered the function `name` whose code starts at `at:def`.
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
    pub bases: Vec<Base>,
    pub functions: Vec<Function>,
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
        let mut read = |line: &str| -> Result<(), String> {
            let record = object(line)?;
            match text(&record, "t")?.as_str() {
                "base" => trace.bases.push(Base {
                    file: text(&record, "file")?,
                    class: text(&record, "class")?,
                    index: number(&record, "index")?,
                    module: text(&record, "module")?,
                    name: text(&record, "name")?,
                    at: match record.get("at") {
                        None | Some(Value::Other) => None,
                        Some(_) => Some(text(&record, "at")?),
                    },
                }),
                "function" => trace.functions.push(Function {
                    file: text(&record, "file")?,
                    line: number(&record, "line")?,
                    name: text(&record, "name")?,
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
        read(line).map_err(|message| format!("line {}: {message}", index + 1))?;
    }
    Ok(trace)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str =
        r#"{"t":"header","tool":"codegraph-trace","version":"0.1.0","python":"3.12.3","root":"/work"}"#;

    #[test]
    fn reads_the_three_records_and_skips_what_it_does_not_know() {
        let trace = parse(&format!(
            "{HEADER}\n{}\n{}\n{}\n{}\n{}\n{}\n",
            r#"{"t":"base","file":"app/shapes.py","class":"Dynamic","index":0,"module":"app.base","name":"Base","at":"app/base.py"}"#,
            r#"{"t":"base","file":"app/shapes.py","class":"factory.<locals>.Local","index":1,"module":"builtins","name":"object"}"#,
            r#"{"t":"function","file":"app/shapes.py","line":17,"name":"Handler.process"}"#,
            r#"{"t":"call","file":"main.py","line":5,"name":"process","at":"app/shapes.py","def":17}"#,
            r#"{"t":"later","anything":null}"#,
            r#"{"t":"eof","bases":2,"functions":1,"calls":1}"#,
        ))
        .unwrap();
        assert_eq!(
            trace.bases,
            vec![
                Base {
                    file: "app/shapes.py".into(),
                    class: "Dynamic".into(),
                    index: 0,
                    module: "app.base".into(),
                    name: "Base".into(),
                    at: Some("app/base.py".into())
                },
                Base {
                    file: "app/shapes.py".into(),
                    class: "factory.<locals>.Local".into(),
                    index: 1,
                    module: "builtins".into(),
                    name: "object".into(),
                    at: None
                }
            ]
        );
        assert_eq!(
            trace.functions,
            vec![Function {
                file: "app/shapes.py".into(),
                line: 17,
                name: "Handler.process".into()
            }]
        );
        assert_eq!(
            trace.calls,
            vec![Call {
                file: "main.py".into(),
                line: 5,
                name: "process".into(),
                at: "app/shapes.py".into(),
                def: 17
            }]
        );
    }

    #[test]
    fn refuses_what_is_not_a_trace_and_says_which_line_is_malformed() {
        assert_eq!(
            parse("{\"t\":\"e\",\"i\":0}\n").unwrap_err(),
            "not a trace: the first line is not a `codegraph-trace` header"
        );
        // A Ruby trace is no Python one, header aside: its records are skipped, not misread.
        let ruby = format!(
            "{HEADER}\n{}\n",
            r#"{"t":"mixin","type":"A","how":"include","module":"B"}"#
        );
        assert_eq!(parse(&ruby).unwrap(), Trace::default());
        let broken = format!("{HEADER}\n{}\n", r#"{"t":"call","file":"a.py","line":"three"}"#);
        assert_eq!(parse(&broken).unwrap_err(), "line 2: `line` must be a line number");
    }
}
