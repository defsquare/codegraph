//! The model as an extractor holds it before writing: natural keys, entities
//! and outgoing edges. Vocabulary strings (kinds, traits, edge kinds,
//! provenance) are core's, written verbatim and never interpreted here.

use std::cmp::Ordering;
use std::sync::{Arc, OnceLock};

/// A natural key `(module, symbol, disambiguator?)` — `lang` is the model's,
/// one for every key a file holds. A module names itself: empty symbol, no
/// disambiguator (schemas/README.md §2). Components are shared text: a key
/// cloned from another, or below it, holds its module's path once, not a copy.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Key {
    pub module: Arc<str>,
    pub symbol: Arc<str>,
    pub d: Option<Arc<str>>,
}

/// The empty symbol every module key holds, allocated once.
pub fn no_symbol() -> Arc<str> {
    static EMPTY: OnceLock<Arc<str>> = OnceLock::new();
    EMPTY.get_or_init(|| Arc::from("")).clone()
}

impl Key {
    pub fn module(module: impl Into<Arc<str>>) -> Self {
        Key {
            module: module.into(),
            symbol: no_symbol(),
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
            name.into()
        } else {
            format!("{}.{}", self.symbol, name).into()
        };
        Key {
            module: self.module.clone(),
            symbol,
            d: None,
        }
    }

    pub fn disambiguated(&self, tag: &str) -> Key {
        let d: Arc<str> = match &self.d {
            None => tag.into(),
            Some(d) => format!("{d}#{tag}").into(),
        };
        Key {
            module: self.module.clone(),
            symbol: self.symbol.clone(),
            d: Some(d),
        }
    }

    /// The display projection `<lang>:<module>[/<symbol>][#<d>]` — for messages and tests only.
    pub fn render(&self, lang: &str) -> String {
        let mut out = format!("{lang}:{}", self.module);
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
    /// Shared: every anchor in one file holds its path once.
    pub file: Arc<str>,
    pub start: u32,
    pub end: u32,
}

/// A written, declaration-site value (METAMODEL §1.6) in core's closed tag set.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Literal {
    String(String),
    /// Canonical decimal text.
    Number(String),
    Boolean(bool),
    Null,
    /// A member of an enumeration: its type, by key, and the member's simple name.
    Enum {
        ty: Key,
        name: String,
    },
    /// A type, by key: closed against the model like any reference.
    Type(Key),
    Array(Vec<Literal>),
    /// A constant expression not folded: its source text.
    Unevaluated(String),
}

/// One argument of an annotation use, always named (METAMODEL §1.6).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct NamedArgument {
    pub name: String,
    pub value: Literal,
}

#[derive(Clone, Debug)]
pub struct Entity {
    pub key: Key,
    pub kind: &'static str,
    pub traits: Vec<&'static str>,
    pub name: Option<String>,
    pub signature: Option<String>,
    /// The type `TTypedEntity` names, by key: closed like any reference. Boxed, as the
    /// other fields most entities lack: an entity is held per declaration, so its size counts.
    pub declared_type: Option<Box<Key>>,
    pub is_stub: Option<bool>,
    pub parent: Option<Key>,
    pub attached_to: Option<Box<Key>>,
    pub parameters: Option<Vec<Key>>,
    pub defined_in: Option<Vec<String>>,
    pub comments: Option<Vec<String>>,
    /// Measures by key (METAMODEL §3.8); written key-sorted.
    pub metrics: Option<Vec<(&'static str, u32)>>,
    pub value: Option<Box<Literal>>,
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
            declared_type: None,
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
    /// An `annotationUse`'s written arguments, in source order; an empty list is not written.
    pub arguments: Option<Vec<NamedArgument>>,
}

#[derive(Debug)]
pub struct Model {
    /// The header's `lang`: the profile every record is read against, and the
    /// prefix of every rendered id.
    pub lang: &'static str,
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
        assert_eq!(file.render("rb"), "rb:lib%2Forder.rb");
        let order = Key {
            module: file.module.clone(),
            symbol: "Acme::Order".into(),
            d: None,
        };
        assert_eq!(
            order.member("total").render("rb"),
            "rb:lib%2Forder.rb/Acme::Order.total"
        );
        // A top-level method sits directly below the file.
        assert_eq!(file.member("main").render("rb"), "rb:lib%2Forder.rb/main");
        let call = order.member("call").disambiguated("self");
        assert_eq!(call.render("rb"), "rb:lib%2Forder.rb/Acme::Order.call#self");
        assert_eq!(
            call.disambiguated("param:args").render("rb"),
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
