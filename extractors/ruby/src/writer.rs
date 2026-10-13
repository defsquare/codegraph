//! The JSONL writer (schemas/README.md): one record per line in canonical
//! order, every reference a surrogate, every path interned, every closed
//! vocabulary an index into the header's dictionaries. Written to match core's
//! own encoder byte for byte — an independent second encoder, so the only
//! thing to get right is the order of everything.

use crate::json;
use crate::model::{Anchor, Edge, Entity, Key, LANG, Literal, Model, utf16_cmp};
use std::collections::HashMap;
use std::io::{self, Write};

const SCHEMA_VERSION: &str = "1.0.0";

#[derive(Debug)]
pub enum WriteError {
    /// Two entities share a natural key: an id-scheme gap, never tolerated.
    DuplicateKey(String),
    /// A reference no record declares: unwritable by construction of the format.
    Dangling {
        from: String,
        to: String,
    },
    /// An entity whose module declares no module entity.
    NoModule(String),
    Io(io::Error),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::DuplicateKey(key) => write!(f, "duplicate natural key: {key}"),
            WriteError::Dangling { from, to } => {
                write!(f, "{from} references an entity this model does not declare: {to}")
            }
            WriteError::NoModule(key) => write!(f, "entity {key} names a module that declares no module entity"),
            WriteError::Io(error) => write!(f, "{error}"),
        }
    }
}

impl From<io::Error> for WriteError {
    fn from(error: io::Error) -> Self {
        WriteError::Io(error)
    }
}

pub struct Counts {
    pub files: usize,
    pub entities: usize,
    pub edges: usize,
}

impl Counts {
    /// Header, files, entities, edges, trailer.
    pub fn records(&self) -> usize {
        self.files + self.entities + self.edges + 2
    }
}

fn sorted_distinct<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut out: Vec<&str> = values.into_iter().collect();
    out.sort_by(|a, b| utf16_cmp(a, b));
    out.dedup();
    out
}

fn index_of<'a>(values: &[&'a str]) -> HashMap<&'a str, usize> {
    values
        .iter()
        .enumerate()
        .map(|(index, value)| (*value, index))
        .collect()
}

/// Writes the model, LF-terminated, to `out`.
pub fn write(model: &Model, out: &mut dyn Write) -> Result<Counts, WriteError> {
    // 1. Canonical order is the surrogate assignment.
    let mut entities: Vec<&Entity> = model.entities.iter().collect();
    entities.sort_by(|a, b| a.key.canonical_cmp(&b.key));

    let mut surrogate_of: HashMap<&Key, usize> = HashMap::with_capacity(entities.len());
    let mut module_surrogate: HashMap<&str, usize> = HashMap::new();
    for (index, entity) in entities.iter().enumerate() {
        if surrogate_of.insert(&entity.key, index).is_some() {
            return Err(WriteError::DuplicateKey(entity.key.render()));
        }
        // 2. A module names itself: the entity with an empty, undisambiguated symbol.
        if entity.key.is_module() {
            module_surrogate.insert(entity.key.module.as_str(), index);
        }
    }
    let reference = |key: &Key, from: &Key| -> Result<usize, WriteError> {
        surrogate_of.get(key).copied().ok_or_else(|| WriteError::Dangling {
            from: from.render(),
            to: key.render(),
        })
    };

    // 3. The file table: every path any record can name, interned once, sorted.
    let mut paths: Vec<&str> = Vec::new();
    for entity in &entities {
        if let Some(anchor) = &entity.anchor {
            paths.push(&anchor.file);
        }
        if let Some(defined_in) = &entity.defined_in {
            paths.extend(defined_in.iter().map(String::as_str));
        }
    }
    paths.extend(model.edges.iter().map(|edge| edge.anchor.file.as_str()));
    let files = sorted_distinct(paths);
    let file_ref = index_of(&files);

    // 4. Dictionaries: what this model actually uses, sorted.
    let kinds = sorted_distinct(entities.iter().map(|e| e.kind));
    let traits = sorted_distinct(entities.iter().flat_map(|e| e.traits.iter().copied()));
    let edge_kinds = sorted_distinct(model.edges.iter().map(|e| e.kind));
    let provenances = sorted_distinct(model.edges.iter().map(|e| e.provenance));
    let kind_ref = index_of(&kinds);
    let trait_ref = index_of(&traits);
    let edge_kind_ref = index_of(&edge_kinds);
    let provenance_ref = index_of(&provenances);

    let anchor = |line: &mut String, anchor: &Anchor| {
        json::integers(
            line,
            [
                file_ref[anchor.file.as_str()],
                anchor.start as usize,
                anchor.end as usize,
            ],
        );
    };

    let mut line = String::with_capacity(256);

    line.push_str("{\"t\":\"header\",\"schemaVersion\":");
    json::string(&mut line, SCHEMA_VERSION);
    line.push_str(",\"lang\":");
    json::string(&mut line, LANG);
    line.push_str(",\"extractor\":");
    object(&mut line, &model.extractor);
    line.push_str(",\"root\":");
    json::string(&mut line, &model.root);
    if let Some(repository) = &model.repository {
        line.push_str(",\"repository\":");
        object(&mut line, repository);
    }
    line.push_str(",\"dict\":{\"kinds\":");
    json::strings(&mut line, kinds.iter().copied());
    line.push_str(",\"traits\":");
    json::strings(&mut line, traits.iter().copied());
    line.push_str(",\"edges\":");
    json::strings(&mut line, edge_kinds.iter().copied());
    line.push_str(",\"provenance\":");
    json::strings(&mut line, provenances.iter().copied());
    line.push_str("}}\n");
    out.write_all(line.as_bytes())?;

    for (index, path) in files.iter().enumerate() {
        line.clear();
        line.push_str(&format!("{{\"t\":\"f\",\"i\":{index},\"path\":"));
        json::string(&mut line, path);
        line.push_str("}\n");
        out.write_all(line.as_bytes())?;
    }

    for (index, entity) in entities.iter().enumerate() {
        let module_index = *module_surrogate
            .get(entity.key.module.as_str())
            .ok_or_else(|| WriteError::NoModule(entity.key.render()))?;
        line.clear();
        line.push_str(&format!(
            "{{\"t\":\"e\",\"i\":{index},\"k\":{},\"tr\":",
            kind_ref[entity.kind]
        ));
        json::integers(&mut line, entity.traits.iter().map(|t| trait_ref[t]));
        line.push_str(&format!(",\"m\":{module_index},\"s\":"));
        // A module writes its own path in the symbol slot; everything else its
        // path below the module.
        json::string(
            &mut line,
            if index == module_index {
                &entity.key.module
            } else {
                &entity.key.symbol
            },
        );
        if let Some(d) = &entity.key.d {
            line.push_str(",\"d\":");
            json::string(&mut line, d);
        }
        // Trait keys, in core's ENTITY_KEY_ORDER.
        if let Some(name) = &entity.name {
            line.push_str(",\"name\":");
            json::string(&mut line, name);
        }
        if let Some(signature) = &entity.signature {
            line.push_str(",\"signature\":");
            json::string(&mut line, signature);
        }
        if let Some(is_stub) = entity.is_stub {
            line.push_str(if is_stub {
                ",\"isStub\":true"
            } else {
                ",\"isStub\":false"
            });
        }
        if let Some(parent) = &entity.parent {
            line.push_str(&format!(",\"parent\":{}", reference(parent, &entity.key)?));
        }
        if let Some(attached_to) = &entity.attached_to {
            line.push_str(&format!(",\"attachedTo\":{}", reference(attached_to, &entity.key)?));
        }
        if let Some(parameters) = &entity.parameters {
            let mut refs = Vec::with_capacity(parameters.len());
            for parameter in parameters {
                refs.push(reference(parameter, &entity.key)?);
            }
            line.push_str(",\"parameters\":");
            json::integers(&mut line, refs);
        }
        if let Some(defined_in) = &entity.defined_in {
            line.push_str(",\"definedIn\":");
            json::integers(&mut line, defined_in.iter().map(|path| file_ref[path.as_str()]));
        }
        if let Some(comments) = &entity.comments {
            line.push_str(",\"comments\":");
            json::strings(&mut line, comments.iter().map(String::as_str));
        }
        if let Some(metrics) = &entity.metrics {
            // Key-sorted: the wire spelling core reads back in order.
            let mut metrics = metrics.clone();
            metrics.sort_by(|(a, _), (b, _)| utf16_cmp(a, b));
            line.push_str(",\"metrics\":{");
            for (index, (key, value)) in metrics.iter().enumerate() {
                if index > 0 {
                    line.push(',');
                }
                json::key(&mut line, key);
                line.push_str(&value.to_string());
            }
            line.push('}');
        }
        if let Some(value) = &entity.value {
            line.push_str(",\"value\":");
            literal(&mut line, value, &|key| reference(key, &entity.key))?;
        }
        if let Some(entity_anchor) = &entity.anchor {
            line.push_str(",\"anchor\":");
            anchor(&mut line, entity_anchor);
        }
        line.push_str("}\n");
        out.write_all(line.as_bytes())?;
    }

    // Edges: by `f`, `o`, edge kind, anchor (file, start, end), provenance.
    let mut edges: Vec<(usize, usize, &Edge)> = Vec::with_capacity(model.edges.len());
    for edge in &model.edges {
        edges.push((
            reference(&edge.from, &edge.from)?,
            reference(&edge.to, &edge.from)?,
            edge,
        ));
    }
    edges.sort_by(|(af, ao, a), (bf, bo, b)| {
        af.cmp(bf)
            .then(ao.cmp(bo))
            .then_with(|| utf16_cmp(a.kind, b.kind))
            .then_with(|| file_ref[a.anchor.file.as_str()].cmp(&file_ref[b.anchor.file.as_str()]))
            .then(a.anchor.start.cmp(&b.anchor.start))
            .then(a.anchor.end.cmp(&b.anchor.end))
            .then_with(|| utf16_cmp(a.provenance, b.provenance))
    });
    for (from, to, edge) in &edges {
        line.clear();
        line.push_str(&format!(
            "{{\"t\":\"x\",\"k\":{},\"f\":{from},\"o\":{to},\"p\":{}",
            edge_kind_ref[edge.kind], provenance_ref[edge.provenance]
        ));
        if let Some((read, write)) = edge.access {
            line.push_str(&format!(",\"isRead\":{read},\"isWrite\":{write}"));
        }
        line.push_str(",\"anchor\":");
        anchor(&mut line, &edge.anchor);
        line.push_str("}\n");
        out.write_all(line.as_bytes())?;
    }

    let counts = Counts {
        files: files.len(),
        entities: entities.len(),
        edges: edges.len(),
    };
    line.clear();
    line.push_str(&format!(
        "{{\"t\":\"eof\",\"counts\":{{\"files\":{},\"entities\":{},\"edges\":{}}}}}\n",
        counts.files, counts.entities, counts.edges
    ));
    out.write_all(line.as_bytes())?;
    out.flush()?;
    Ok(counts)
}

/// A literal (METAMODEL §1.6): `k` first, then its one field; a type is a
/// surrogate like every reference.
fn literal(
    line: &mut String,
    value: &Literal,
    reference: &dyn Fn(&Key) -> Result<usize, WriteError>,
) -> Result<(), WriteError> {
    match value {
        Literal::String(text) => {
            line.push_str("{\"k\":\"string\",\"v\":");
            json::string(line, text);
            line.push('}');
        }
        Literal::Number(text) => {
            line.push_str("{\"k\":\"number\",\"v\":");
            json::string(line, text);
            line.push('}');
        }
        Literal::Boolean(flag) => line.push_str(&format!("{{\"k\":\"boolean\",\"v\":{flag}}}")),
        Literal::Null => line.push_str("{\"k\":\"null\"}"),
        Literal::Type(key) => line.push_str(&format!("{{\"k\":\"type\",\"type\":{}}}", reference(key)?)),
        Literal::Array(items) => {
            line.push_str("{\"k\":\"array\",\"items\":[");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    line.push(',');
                }
                literal(line, item, reference)?;
            }
            line.push_str("]}");
        }
        Literal::Unevaluated(source) => {
            line.push_str("{\"k\":\"unevaluated\",\"source\":");
            json::string(line, source);
            line.push('}');
        }
    }
    Ok(())
}

fn object(line: &mut String, pairs: &[(&'static str, String)]) {
    line.push('{');
    for (index, (key, value)) in pairs.iter().enumerate() {
        if index > 0 {
            line.push(',');
        }
        json::key(line, key);
        json::string(line, value);
    }
    line.push('}');
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids;

    fn file(path: &str) -> Entity {
        let mut entity = Entity::new(ids::file_key(path), "file", &["TNamed", "TModule", "TWithChildren"]);
        entity.name = Some(path.to_owned());
        entity.is_stub = Some(false);
        entity.defined_in = Some(vec![path.to_owned()]);
        entity
    }

    fn model(entities: Vec<Entity>, edges: Vec<Edge>) -> Model {
        Model {
            extractor: vec![("name", "codegraph-ruby".into()), ("version", "0.0.0".into())],
            root: "src".into(),
            repository: None,
            entities,
            edges,
        }
    }

    fn written(model: &Model) -> String {
        let mut out = Vec::new();
        write(model, &mut out).expect("writes");
        String::from_utf8(out).expect("utf-8")
    }

    #[test]
    fn writes_sections_in_order_with_dense_surrogates_whatever_the_input_order() {
        let b = file("b.rb");
        let a = file("a.rb");
        let edge = Edge {
            kind: "import",
            from: b.key.clone(),
            to: a.key.clone(),
            provenance: "declared",
            anchor: Anchor {
                file: "b.rb".into(),
                start: 1,
                end: 1,
            },
            access: None,
        };
        let text = written(&model(vec![b, a], vec![edge]));
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines,
            vec![
                r#"{"t":"header","schemaVersion":"1.0.0","lang":"rb","extractor":{"name":"codegraph-ruby","version":"0.0.0"},"root":"src","dict":{"kinds":["file"],"traits":["TModule","TNamed","TWithChildren"],"edges":["import"],"provenance":["declared"]}}"#,
                r#"{"t":"f","i":0,"path":"a.rb"}"#,
                r#"{"t":"f","i":1,"path":"b.rb"}"#,
                r#"{"t":"e","i":0,"k":0,"tr":[1,0,2],"m":0,"s":"a.rb","name":"a.rb","isStub":false,"definedIn":[0]}"#,
                r#"{"t":"e","i":1,"k":0,"tr":[1,0,2],"m":1,"s":"b.rb","name":"b.rb","isStub":false,"definedIn":[1]}"#,
                r#"{"t":"x","k":0,"f":1,"o":0,"p":0,"anchor":[1,1,1]}"#,
                r#"{"t":"eof","counts":{"files":2,"entities":2,"edges":1}}"#,
            ]
        );
        assert!(text.ends_with("}\n"));
    }

    #[test]
    fn refuses_a_duplicate_key_and_a_dangling_reference() {
        let duplicate = write(&model(vec![file("a.rb"), file("a.rb")], vec![]), &mut Vec::new());
        assert!(matches!(duplicate, Err(WriteError::DuplicateKey(key)) if key == "rb:a.rb"));

        let mut orphan = Entity::new(ids::type_key(&ids::file_key("a.rb"), "A"), "class", &["TNamed"]);
        orphan.parent = Some(ids::file_key("missing.rb"));
        let dangling = write(&model(vec![file("a.rb"), orphan], vec![]), &mut Vec::new());
        assert!(matches!(dangling, Err(WriteError::Dangling { to, .. }) if to == "rb:missing.rb"));
    }
}
