//! The model file, read as the container contract lets any reader read it
//! (`schemas/README.md`): one record per line, the type in the leading `t`
//! key, dictionaries in the header. Nothing is re-encoded that is not changed.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::ops::Range;

use serde::Deserialize;

/// What a join needs to know of an entity's traits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Category {
    /// `TModule`: a file-scoped module, joined to the file's unit space.
    Unit,
    /// `TInvocable`.
    Invocable,
    /// `TType`.
    Type,
    /// Measured by its extractor but neither of the above (a C# property, a
    /// TypeScript namespace).
    Other,
}

/// A measured entity (it declares `TMetrics`) that has an anchor.
#[derive(Clone, Debug)]
pub struct Measurable {
    pub entity: u32,
    pub file: u32,
    pub start: u32,
    pub end: u32,
    pub category: Category,
    /// Containment depth in the model (`parent` hops to a root).
    pub depth: u32,
    /// Anchored exactly where its parent is — an implicit constructor on its
    /// class, a dotted namespace's inner name: nothing of its own to contain.
    pub implicit: bool,
    /// The extractor's own `sloc`, when it wrote one: the join's witness.
    pub sloc: Option<u64>,
    /// The natural key's `(m, s, d)`: module surrogate, symbol, disambiguator.
    pub module: u32,
    pub symbol: String,
    pub disambiguator: Option<String>,
}

/// Pass one's result.
pub struct Inventory {
    pub lang: String,
    pub root: Option<String>,
    /// The header's `repository.commit`: the commit the model describes.
    pub commit: Option<String>,
    pub files: Vec<String>,
    pub measurable: Vec<Measurable>,
    /// Entities declaring `TMetrics`, anchored or not.
    pub declaring: usize,
    /// Module surrogate → module path: a module names itself (contract §2).
    pub modules: HashMap<u32, String>,
}

#[derive(Deserialize)]
struct HeaderRecord {
    lang: String,
    #[serde(default)]
    root: Option<String>,
    #[serde(default)]
    repository: Option<RepositoryRecord>,
    dict: Dict,
}

#[derive(Deserialize)]
struct RepositoryRecord {
    commit: String,
}

#[derive(Deserialize)]
struct Dict {
    traits: Vec<String>,
}

#[derive(Deserialize)]
struct FileRecord {
    i: u32,
    path: String,
}

#[derive(Deserialize)]
struct EntityRecord {
    i: u32,
    tr: Vec<usize>,
    m: u32,
    s: String,
    #[serde(default)]
    d: Option<String>,
    #[serde(default)]
    parent: Option<u32>,
    #[serde(default)]
    anchor: Option<(u32, u32, u32)>,
    #[serde(default)]
    metrics: Option<HashMap<String, serde_json::Value>>,
}

/// The record type of a line, from its leading `t` key.
fn tag(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("{\"t\":\"")?;
    rest.split_once('"').map(|(t, _)| t)
}

/// Trait-dictionary indices the join reads.
struct TraitIndex {
    metrics: Option<usize>,
    invocable: Option<usize>,
    kind_type: Option<usize>,
    module: Option<usize>,
}

impl TraitIndex {
    fn new(traits: &[String]) -> Self {
        let at = |name: &str| traits.iter().position(|t| t == name);
        Self {
            metrics: at("TMetrics"),
            invocable: at("TInvocable"),
            kind_type: at("TType"),
            module: at("TModule"),
        }
    }

    fn category(&self, tr: &[usize]) -> Category {
        let has = |t: Option<usize>| t.is_some_and(|t| tr.contains(&t));
        if has(self.module) {
            Category::Unit
        } else if has(self.invocable) {
            Category::Invocable
        } else if has(self.kind_type) {
            Category::Type
        } else {
            Category::Other
        }
    }
}

/// Pass one: the header, the file table and every measured, anchored entity.
pub fn inventory(input: impl BufRead) -> Result<Inventory, String> {
    let mut header: Option<(HeaderRecord, TraitIndex)> = None;
    let mut files = Vec::new();
    let mut parents: Vec<Option<u32>> = Vec::new();
    let mut anchors: Vec<Option<(u32, u32, u32)>> = Vec::new();
    let mut measurable = Vec::new();
    let mut declaring = 0;
    let mut modules = HashMap::new();
    for (number, line) in input.lines().enumerate() {
        let line = line.map_err(|e| format!("reading the model: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let at = |e: serde_json::Error| format!("line {}: {e}", number + 1);
        match tag(&line) {
            Some("header") => {
                let record: HeaderRecord = serde_json::from_str(&line).map_err(at)?;
                let index = TraitIndex::new(&record.dict.traits);
                header = Some((record, index));
            }
            Some("f") => {
                let record: FileRecord = serde_json::from_str(&line).map_err(at)?;
                if record.i as usize != files.len() {
                    return Err(format!("line {}: file records out of order", number + 1));
                }
                files.push(record.path);
            }
            Some("e") => {
                let (_, index) = header.as_ref().ok_or("an entity before the header")?;
                let record: EntityRecord = serde_json::from_str(&line).map_err(at)?;
                if record.i as usize != parents.len() {
                    return Err(format!("line {}: entity records out of order", number + 1));
                }
                parents.push(record.parent);
                anchors.push(record.anchor);
                if record.m == record.i {
                    modules.insert(record.i, record.s.clone());
                }
                if !index.metrics.is_some_and(|t| record.tr.contains(&t)) {
                    continue;
                }
                declaring += 1;
                if let Some((file, start, end)) = record.anchor {
                    let sloc = record
                        .metrics
                        .as_ref()
                        .and_then(|m| m.get("sloc"))
                        .and_then(serde_json::Value::as_u64);
                    measurable.push(Measurable {
                        entity: record.i,
                        file,
                        start,
                        end,
                        category: index.category(&record.tr),
                        depth: 0,
                        implicit: false,
                        sloc,
                        module: record.m,
                        symbol: record.s,
                        disambiguator: record.d,
                    });
                }
            }
            Some("x" | "eof") => {}
            _ => return Err(format!("line {}: not a codegraph model record", number + 1)),
        }
    }
    let (header, _) = header.ok_or("no header record: not a codegraph model")?;
    let depths = depths(&parents);
    for m in &mut measurable {
        m.depth = depths[m.entity as usize];
        let parent_anchor = parents[m.entity as usize].and_then(|p| anchors.get(p as usize).copied().flatten());
        m.implicit = parent_anchor == Some((m.file, m.start, m.end));
    }
    Ok(Inventory {
        lang: header.lang,
        root: header.root,
        commit: header.repository.map(|r| r.commit),
        files,
        measurable,
        declaring,
        modules,
    })
}

/// Containment depth of every entity, following `parent` (a cycle, which a
/// valid model cannot hold, stops at the entity count).
fn depths(parents: &[Option<u32>]) -> Vec<u32> {
    let mut depth: Vec<Option<u32>> = vec![None; parents.len()];
    for start in 0..parents.len() {
        let mut chain = Vec::new();
        let mut at = start;
        let base = loop {
            if let Some(d) = depth[at] {
                break d;
            }
            chain.push(at);
            match parents[at] {
                Some(p) if (p as usize) < parents.len() && chain.len() <= parents.len() => at = p as usize,
                _ => break 0,
            }
        };
        // `base` is the depth of the first already-known ancestor, or 0 for a
        // root that is itself the last element of `chain`.
        let first = if depth[at].is_some() { base + 1 } else { 0 };
        for (&entity, d) in chain.iter().rev().zip(first..) {
            depth[entity] = Some(d);
        }
    }
    depth.into_iter().map(|d| d.unwrap_or(0)).collect()
}

/// Pass two: copies the model, replacing the `metrics` value of each entity
/// `rewrite` answers for. Returns how many lines changed.
pub fn rewrite(
    input: impl BufRead,
    mut output: impl Write,
    mut rewrite: impl FnMut(u32, &str) -> Option<String>,
) -> Result<usize, String> {
    let mut changed = 0;
    for line in input.split(b'\n') {
        let line = line.map_err(|e| format!("reading the model: {e}"))?;
        let text = std::str::from_utf8(&line).map_err(|e| format!("the model is not UTF-8: {e}"))?;
        let replaced = if tag(text) == Some("e") {
            member_range(text, "metrics").and_then(|range| {
                let entity = member_range(text, "i").and_then(|i| text[i].parse::<u32>().ok())?;
                let fresh = rewrite(entity, &text[range.clone()])?;
                (fresh != text[range.clone()]).then(|| format!("{}{fresh}{}", &text[..range.start], &text[range.end..]))
            })
        } else {
            None
        };
        let bytes = match &replaced {
            Some(fresh) => {
                changed += 1;
                fresh.as_bytes()
            }
            None => &line,
        };
        output
            .write_all(bytes)
            .and_then(|()| output.write_all(b"\n"))
            .map_err(|e| format!("writing: {e}"))?;
    }
    Ok(changed)
}

/// The members of a JSON object, as (decoded key, raw value) pairs in order.
pub fn members(object: &str) -> Option<Vec<(String, &str)>> {
    let b = object.as_bytes();
    let mut out = Vec::new();
    let mut i = skip_ws(b, 0);
    if b.get(i) != Some(&b'{') {
        return None;
    }
    i = skip_ws(b, i + 1);
    if b.get(i) == Some(&b'}') {
        return Some(out);
    }
    loop {
        let key_end = skip_string(b, i)?;
        let key: String = serde_json::from_str(&object[i..key_end]).ok()?;
        i = skip_ws(b, key_end);
        if b.get(i) != Some(&b':') {
            return None;
        }
        let start = skip_ws(b, i + 1);
        let end = skip_value(b, start)?;
        out.push((key, &object[start..end]));
        i = skip_ws(b, end);
        match b.get(i)? {
            b',' => i = skip_ws(b, i + 1),
            b'}' => return Some(out),
            _ => return None,
        }
    }
}

/// The byte range of top-level member `key`'s value in a one-object line.
pub fn member_range(line: &str, key: &str) -> Option<Range<usize>> {
    let b = line.as_bytes();
    let mut i = skip_ws(b, 0);
    if b.get(i) != Some(&b'{') {
        return None;
    }
    i = skip_ws(b, i + 1);
    loop {
        if b.get(i)? != &b'"' {
            return None;
        }
        let key_end = skip_string(b, i)?;
        let name = &line[i + 1..key_end - 1];
        i = skip_ws(b, key_end);
        if b.get(i) != Some(&b':') {
            return None;
        }
        let start = skip_ws(b, i + 1);
        let end = skip_value(b, start)?;
        if name == key {
            return Some(start..end);
        }
        i = skip_ws(b, end);
        match b.get(i)? {
            b',' => i = skip_ws(b, i + 1),
            _ => return None,
        }
    }
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while b.get(i).is_some_and(|c| matches!(c, b' ' | b'\t' | b'\r' | b'\n')) {
        i += 1;
    }
    i
}

/// Index just past the string opening at `i`.
fn skip_string(b: &[u8], i: usize) -> Option<usize> {
    if b.get(i) != Some(&b'"') {
        return None;
    }
    let mut j = i + 1;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            b'"' => return Some(j + 1),
            _ => j += 1,
        }
    }
    None
}

/// Index just past the value starting at `i`.
fn skip_value(b: &[u8], i: usize) -> Option<usize> {
    match b.get(i)? {
        b'"' => skip_string(b, i),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut j = i;
            while j < b.len() {
                match b[j] {
                    b'"' => {
                        j = skip_string(b, j)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            None
        }
        _ => {
            let mut j = i;
            while j < b.len() && !matches!(b[j], b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n') {
                j += 1;
            }
            (j > i).then_some(j)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{depths, member_range, members, tag};

    #[test]
    fn finds_a_top_level_member_and_never_one_inside_a_string_or_object() {
        let line = r#"{"t":"e","i":7,"comments":["\"metrics\":{} is text"],"value":{"metrics":1},"metrics":{"sloc":4},"anchor":[0,1,2]}"#;
        assert_eq!(tag(line), Some("e"));
        let range = member_range(line, "metrics").unwrap();
        assert_eq!(&line[range], r#"{"sloc":4}"#);
        assert_eq!(&line[member_range(line, "i").unwrap()], "7");
        assert_eq!(member_range(line, "absent"), None);
    }

    #[test]
    fn splits_an_object_into_raw_members() {
        let object = r#"{"cyclomatic":1,"sé":2.5,"sloc":4}"#;
        let got = members(object).unwrap();
        assert_eq!(
            got,
            vec![
                ("cyclomatic".to_owned(), "1"),
                ("sé".to_owned(), "2.5"),
                ("sloc".to_owned(), "4")
            ]
        );
        assert_eq!(members("{}").unwrap(), vec![]);
        assert_eq!(members("{\"a\":1,}"), None);
    }

    #[test]
    fn depth_follows_parent_links_in_any_order() {
        // 0 ← 2 ← 1, and 3 alone.
        assert_eq!(depths(&[None, Some(2), Some(0), None]), vec![0, 2, 1, 0]);
    }
}
