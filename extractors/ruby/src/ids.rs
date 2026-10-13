//! THE Ruby id scheme (PLAN.md §19.3).
//!
//! ```text
//! file (module)     rb:lib%2Facme%2Forder.rb                  path relative to the root, escaped
//! reserved          rb:<ruby>   rb:<gems>                      what the VM defines / what nothing here declares
//! external feature  rb:<gems>%2Fnokogiri                       a `require` no corpus file answers, as written
//! missing relative  rb:lib%2Facme%2Fmissing.rb                 a `require_relative` to a file that is not there
//! class / module    rb:lib%2Facme%2Forder.rb/Acme::Order       the fully qualified constant path
//! stub type         rb:<ruby>/StandardError   rb:<gems>/ActiveRecord::Base
//! method            …/Acme::Order.total       singleton: …/Acme::Order.call#self
//! operator          …/Acme::Money.%2F         …/Acme::Money.<=>
//! parameter         …/Acme::Order.total#param:currency         unnamed or repeated: #param:<ordinal>
//! ```

use crate::model::Key;

/// The stub module of what the VM defines before any file runs.
pub const RUBY: &str = "<ruby>";
/// The stub module of what the roots do not declare and the VM does not define.
pub const GEMS: &str = "<gems>";

/// A root-relative `/`-separated path as a module key: `/` is the key's own
/// separator, `#` its disambiguator mark, `%` the escape itself, and `<` opens
/// a reserved module — so no walked path can spell `<ruby>` or `<gems>`.
pub fn escape_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 8);
    for ch in path.chars() {
        match ch {
            '%' => out.push_str("%25"),
            '/' => out.push_str("%2F"),
            '#' => out.push_str("%23"),
            '<' => out.push_str("%3C"),
            c => out.push(c),
        }
    }
    out
}

/// A method or parameter name inside a symbol: Ruby names a method `/` or `%`.
pub fn escape_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            '%' => out.push_str("%25"),
            '/' => out.push_str("%2F"),
            '#' => out.push_str("%23"),
            c => out.push(c),
        }
    }
    out
}

pub fn file_key(path: &str) -> Key {
    Key::module(escape_path(path))
}

/// The stub module of a feature a `require` names and no corpus file answers.
pub fn feature_key(feature: &str) -> Key {
    Key::module(format!("{GEMS}%2F{}", escape_path(feature)))
}

pub fn reserved_key(reserved: &str) -> Key {
    Key::module(reserved)
}

/// A class or module below its file (or a stub type below its reserved module).
pub fn type_key(module: &Key, fqn: &str) -> Key {
    Key {
        module: module.module.clone(),
        symbol: escape_name(fqn),
        d: None,
    }
}

/// A method below its owner — a type, or the file for a top-level `def`.
pub fn method_key(owner: &Key, name: &str, singleton: bool) -> Key {
    let key = owner.member(&escape_name(name));
    if singleton { key.disambiguated("self") } else { key }
}

/// An instance variable — and the `attr_*` that exposes it — below its type.
/// One of the class itself carries `self`, as a singleton method does.
pub fn field_key(owner: &Key, name: &str, on_class: bool) -> Key {
    let key = owner.member(&escape_name(name));
    if on_class { key.disambiguated("self") } else { key }
}

/// A parameter below its method: by name, or by 1-based ordinal.
pub fn parameter_key(method: &Key, tag: &str) -> Key {
    method.disambiguated(&format!("param:{}", escape_name(tag)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unescape(text: &str) -> String {
        text.replace("%2F", "/")
            .replace("%23", "#")
            .replace("%3C", "<")
            .replace("%25", "%")
    }

    #[test]
    fn keys_have_the_documented_shapes() {
        let file = file_key("lib/acme/order.rb");
        assert_eq!(file.render(), "rb:lib%2Facme%2Forder.rb");
        let order = type_key(&file, "Acme::Order");
        assert_eq!(order.render(), "rb:lib%2Facme%2Forder.rb/Acme::Order");
        assert_eq!(
            method_key(&order, "total", false).render(),
            "rb:lib%2Facme%2Forder.rb/Acme::Order.total"
        );
        assert_eq!(
            method_key(&order, "call", true).render(),
            "rb:lib%2Facme%2Forder.rb/Acme::Order.call#self"
        );
        assert_eq!(
            method_key(&order, "/", false).render(),
            "rb:lib%2Facme%2Forder.rb/Acme::Order.%2F"
        );
        assert_eq!(
            method_key(&order, "%", false).render(),
            "rb:lib%2Facme%2Forder.rb/Acme::Order.%25"
        );
        assert_eq!(
            method_key(&order, "<=>", false).render(),
            "rb:lib%2Facme%2Forder.rb/Acme::Order.<=>"
        );
        let call = method_key(&order, "call", true);
        assert_eq!(
            parameter_key(&call, "args").render(),
            "rb:lib%2Facme%2Forder.rb/Acme::Order.call#self#param:args"
        );
        assert_eq!(
            parameter_key(&call, "1").render(),
            "rb:lib%2Facme%2Forder.rb/Acme::Order.call#self#param:1"
        );
        assert_eq!(
            type_key(&reserved_key(RUBY), "StandardError").render(),
            "rb:<ruby>/StandardError"
        );
        assert_eq!(feature_key("net/http").render(), "rb:<gems>%2Fnet%2Fhttp");
    }

    #[test]
    fn no_walked_path_can_spell_a_reserved_module() {
        // Legal file names on Linux; each must stay distinct from the reserved keys.
        assert_eq!(file_key("<ruby>").render(), "rb:%3Cruby>");
        assert_eq!(file_key("<gems>/json.rb").render(), "rb:%3Cgems>%2Fjson.rb");
        assert_ne!(file_key("<gems>/json.rb"), feature_key("json.rb"));
        assert_eq!(file_key("lib/promo#2024.rb").render(), "rb:lib%2Fpromo%232024.rb");
    }

    #[test]
    fn escaping_is_injective_and_reversible_over_the_reserved_alphabet() {
        // Every string of length ≤ 4 over the characters that matter, exhaustively.
        let alphabet = ['%', '/', '#', '<', '2', 'F', '5', 'a'];
        let mut seen = std::collections::HashMap::new();
        let mut frontier = vec![String::new()];
        for _ in 0..4 {
            let mut next = Vec::new();
            for prefix in &frontier {
                for ch in alphabet {
                    let mut text = prefix.clone();
                    text.push(ch);
                    next.push(text);
                }
            }
            for text in &next {
                let escaped = escape_path(text);
                assert_eq!(unescape(&escaped), *text, "round trip of {text:?}");
                assert!(
                    !escaped.contains('/') && !escaped.contains('#') && !escaped.contains('<'),
                    "{escaped:?}"
                );
                if let Some(previous) = seen.insert(escaped.clone(), text.clone()) {
                    panic!("{previous:?} and {text:?} both escape to {escaped:?}");
                }
            }
            frontier = next;
        }
    }
}
