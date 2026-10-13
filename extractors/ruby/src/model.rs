//! The model as this extractor holds it before writing: natural keys, entities
//! and outgoing edges. Vocabulary strings (kinds, traits, edge kinds,
//! provenance) are core's, written verbatim and never interpreted here.

use std::cmp::Ordering;

pub const LANG: &str = "rb";

/// A natural key `(module, symbol, disambiguator?)` — `lang` is `rb` for every
/// key this extractor writes. A module names itself: empty symbol, no
/// disambiguator (schemas/README.md §2).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Key {
    pub module: String,
    pub symbol: String,
    pub d: Option<String>,
}

impl Key {
    pub fn module(module: impl Into<String>) -> Self {
        Key {
            module: module.into(),
            symbol: String::new(),
            d: None,
        }
    }

    pub fn is_module(&self) -> bool {
        self.symbol.is_empty() && self.d.is_none()
    }

    /// `Owner.member` below an owner with no disambiguator; below the owner's
    /// own disambiguator otherwise.
    pub fn member(&self, name: &str) -> Key {
        if self.d.is_some() {
            return self.disambiguated(name);
        }
        let symbol = if self.symbol.is_empty() {
            name.to_owned()
        } else {
            format!("{}.{}", self.symbol, name)
        };
        Key {
            module: self.module.clone(),
            symbol,
            d: None,
        }
    }

    pub fn disambiguated(&self, tag: &str) -> Key {
        let d = match &self.d {
            None => tag.to_owned(),
            Some(d) => format!("{d}#{tag}"),
        };
        Key {
            module: self.module.clone(),
            symbol: self.symbol.clone(),
            d: Some(d),
        }
    }

    /// The display projection `rb:<module>[/<symbol>][#<d>]` — for messages and tests only.
    pub fn render(&self) -> String {
        let mut out = format!("{LANG}:{}", self.module);
        if !self.symbol.is_empty() {
            out.push('/');
            out.push_str(&self.symbol);
        }
        if let Some(d) = &self.d {
            out.push('#');
            out.push_str(d);
        }
        out
    }

    /// Canonical order (§6): module, symbol, then disambiguator with the absent
    /// one first, each by UTF-16 code unit. This order IS the surrogate assignment.
    pub fn canonical_cmp(&self, other: &Key) -> Ordering {
        utf16_cmp(&self.module, &other.module)
            .then_with(|| utf16_cmp(&self.symbol, &other.symbol))
            .then_with(|| match (&self.d, &other.d) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Less,
                (Some(_), None) => Ordering::Greater,
                (Some(a), Some(b)) => utf16_cmp(a, b),
            })
    }
}

/// Total order on text by UTF-16 code unit — what JavaScript's `<` compares,
/// and NOT Rust's byte order: U+FF5E sorts after U+1F600 here, before it in UTF-8.
pub fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `[file, startLine, endLine]`, 1-based and inclusive; `file` is root-relative.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Anchor {
    pub file: String,
    pub start: u32,
    pub end: u32,
}

/// A written, declaration-site value (METAMODEL §1.6) in core's closed tag set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Literal {
    String(String),
    /// Canonical decimal text.
    Number(String),
    Boolean(bool),
    Null,
    /// A type, by key: closed against the model like any reference.
    Type(Key),
    Array(Vec<Literal>),
    /// A constant expression not folded: its source text.
    Unevaluated(String),
}

#[derive(Clone, Debug)]
pub struct Entity {
    pub key: Key,
    pub kind: &'static str,
    pub traits: Vec<&'static str>,
    pub name: Option<String>,
    pub signature: Option<String>,
    pub is_stub: Option<bool>,
    pub parent: Option<Key>,
    pub attached_to: Option<Key>,
    pub parameters: Option<Vec<Key>>,
    pub defined_in: Option<Vec<String>>,
    pub comments: Option<Vec<String>>,
    /// Measures by key (METAMODEL §3.8); written key-sorted.
    pub metrics: Option<Vec<(&'static str, u32)>>,
    pub value: Option<Literal>,
    pub anchor: Option<Anchor>,
}

impl Entity {
    pub fn new(key: Key, kind: &'static str, traits: &[&'static str]) -> Self {
        Entity {
            key,
            kind,
            traits: traits.to_vec(),
            name: None,
            signature: None,
            is_stub: None,
            parent: None,
            attached_to: None,
            parameters: None,
            defined_in: None,
            comments: None,
            metrics: None,
            value: None,
            anchor: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Edge {
    pub kind: &'static str,
    pub from: Key,
    pub to: Key,
    pub provenance: &'static str,
    pub anchor: Anchor,
    /// `(isRead, isWrite)` — on an `access` edge, and only there.
    pub access: Option<(bool, bool)>,
    /// Every target a `dynamic-candidate` invocation was seen to reach, `to`
    /// among them; absent on any other edge.
    pub candidates: Option<Vec<Key>>,
}

#[derive(Debug)]
pub struct Model {
    /// The header's `extractor` object, in the order written.
    pub extractor: Vec<(&'static str, String)>,
    pub root: String,
    /// `--repo-*` copied verbatim, in the order written; absent when not given.
    pub repository: Option<Vec<(&'static str, String)>>,
    pub entities: Vec<Entity>,
    pub edges: Vec<Edge>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_module_names_itself_and_members_nest_with_a_dot() {
        let file = Key::module("lib%2Forder.rb");
        assert!(file.is_module());
        assert_eq!(file.render(), "rb:lib%2Forder.rb");
        let order = Key {
            module: file.module.clone(),
            symbol: "Acme::Order".into(),
            d: None,
        };
        assert_eq!(order.member("total").render(), "rb:lib%2Forder.rb/Acme::Order.total");
        // A top-level method sits directly below the file.
        assert_eq!(file.member("main").render(), "rb:lib%2Forder.rb/main");
        let call = order.member("call").disambiguated("self");
        assert_eq!(call.render(), "rb:lib%2Forder.rb/Acme::Order.call#self");
        assert_eq!(
            call.disambiguated("param:args").render(),
            "rb:lib%2Forder.rb/Acme::Order.call#self#param:args"
        );
    }

    #[test]
    fn canonical_order_is_utf16_code_units_with_the_absent_disambiguator_first() {
        // U+FF5E is one unit 0xFF5E; U+1F600 is a surrogate pair starting 0xD83D.
        assert_eq!(utf16_cmp("\u{ff5e}", "\u{1f600}"), Ordering::Greater);
        assert_eq!(
            "\u{ff5e}".cmp("\u{1f600}"),
            Ordering::Less,
            "byte order disagrees, which is the point"
        );
        let plain = Key {
            module: "m".into(),
            symbol: "A.call".into(),
            d: None,
        };
        let singleton = plain.disambiguated("self");
        assert_eq!(plain.canonical_cmp(&singleton), Ordering::Less);
        assert_eq!(Key::module("m").canonical_cmp(&plain), Ordering::Less);
    }
}
