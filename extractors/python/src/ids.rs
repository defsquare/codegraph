//! THE Python id scheme (PLAN.md §23.3).
//!
//! ```text
//! module (file)      python:src%2Facme%2Forder.py         path relative to the root, escaped
//! package            python:src%2Facme%2F__init__.py      a package is its __init__ file
//! reserved           python:<builtins>                    what the interpreter binds before any file runs
//! standard library   python:<stdlib>%2Fos.path            a module of the table, as the import writes it
//! third party        python:<site>%2Fdjango.db.models     a module nothing here declares, as written
//! missing relative   python:src%2Facme%2Fmissing.py       a relative import to a file that is not there
//! class / function   …/Order   …/Order.Line   …/total_of.helper   …/make.Local
//! method             …/Order.total   accessors: …/Order.total#setter   …/Order.total#deleter
//! parameter          …/Order.total#param:currency         …/Order.total#setter#param:value
//! stub type          python:<builtins>/ValueError   python:<stdlib>%2Fenum/Enum
//! ```
//!
//! A name is an identifier (NFKC-normalized by the parser, as the language
//! does): it holds no `/`, `#` or `%`, and `.` cannot occur in one, so it nests
//! unescaped. Only path segments are escaped.

use codegraph_model::Key;

/// The model's `lang`: the profile core reads it against, the prefix of every id.
pub const LANG: &str = "python";

/// The stub module of what the interpreter binds before any file runs.
pub const BUILTINS: &str = "<builtins>";
/// The prefix of a standard-library module: the table names it.
pub const STDLIB: &str = "<stdlib>";
/// The prefix of a module nothing here declares and the table does not name.
pub const SITE: &str = "<site>";

/// A root-relative `/`-separated path as a module key: `/` is the key's own
/// separator, `#` its disambiguator mark, `%` the escape itself, and `<` opens
/// a reserved module — so no walked path can spell one.
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

pub fn file_key(path: &str) -> Key {
    Key::module(escape_path(path))
}

pub fn builtins_key() -> Key {
    Key::module(BUILTINS)
}

/// A module of the standard library, by the dotted name the import writes.
pub fn stdlib_key(dotted: &str) -> Key {
    Key::module(format!("{STDLIB}%2F{}", escape_path(dotted)))
}

/// A module nothing here declares, by the dotted name the import writes.
pub fn site_key(dotted: &str) -> Key {
    Key::module(format!("{SITE}%2F{}", escape_path(dotted)))
}

/// A class or a function below its owner: a module, a class, a function.
pub fn member_key(owner: &Key, name: &str) -> Key {
    owner.member(name)
}

/// A property's setter, deleter or getter: the word the source writes after the dot.
pub fn accessor_key(method: &Key, word: &str) -> Key {
    method.disambiguated(word)
}

pub fn parameter_key(invocable: &Key, name: &str) -> Key {
    invocable.disambiguated(&format!("param:{name}"))
}

/// A stub type below its stub module, by the name as written at the site.
pub fn stub_type_key(module: &Key, symbol: &str) -> Key {
    module.member(symbol)
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
        let order = file_key("src/acme/order.py");
        assert_eq!(order.render(LANG), "python:src%2Facme%2Forder.py");
        assert_eq!(
            file_key("src/acme/__init__.py").render(LANG),
            "python:src%2Facme%2F__init__.py"
        );
        assert_eq!(builtins_key().render(LANG), "python:<builtins>");
        assert_eq!(stdlib_key("os.path").render(LANG), "python:<stdlib>%2Fos.path");
        assert_eq!(
            site_key("django.db.models").render(LANG),
            "python:<site>%2Fdjango.db.models"
        );
        let class = member_key(&order, "Order");
        assert_eq!(class.render(LANG), "python:src%2Facme%2Forder.py/Order");
        assert_eq!(
            member_key(&class, "Line").render(LANG),
            "python:src%2Facme%2Forder.py/Order.Line"
        );
        let total = member_key(&class, "total");
        assert_eq!(total.render(LANG), "python:src%2Facme%2Forder.py/Order.total");
        let setter = accessor_key(&total, "setter");
        assert_eq!(setter.render(LANG), "python:src%2Facme%2Forder.py/Order.total#setter");
        assert_eq!(
            parameter_key(&total, "currency").render(LANG),
            "python:src%2Facme%2Forder.py/Order.total#param:currency"
        );
        assert_eq!(
            parameter_key(&setter, "value").render(LANG),
            "python:src%2Facme%2Forder.py/Order.total#setter#param:value"
        );
        let make = member_key(&order, "make");
        assert_eq!(
            member_key(&make, "Local").render(LANG),
            "python:src%2Facme%2Forder.py/make.Local"
        );
        assert_eq!(
            stub_type_key(&builtins_key(), "ValueError").render(LANG),
            "python:<builtins>/ValueError"
        );
        assert_eq!(
            stub_type_key(&stdlib_key("enum"), "Enum").render(LANG),
            "python:<stdlib>%2Fenum/Enum"
        );
        assert_eq!(
            stub_type_key(&site_key("django.db"), "models.Model").render(LANG),
            "python:<site>%2Fdjango.db/models.Model"
        );
    }

    #[test]
    fn no_walked_path_can_spell_a_reserved_module() {
        // Legal file names on Linux; each must stay distinct from the reserved keys.
        assert_eq!(file_key("<builtins>").render(LANG), "python:%3Cbuiltins>");
        assert_ne!(file_key("<builtins>"), builtins_key());
        assert_ne!(file_key("<stdlib>/os.path"), stdlib_key("os.path"));
        assert_ne!(file_key("<site>/six"), site_key("six"));
        assert_eq!(
            file_key("src/promo#2024.py").render(LANG),
            "python:src%2Fpromo%232024.py"
        );
        assert_eq!(file_key("src/100%.py").render(LANG), "python:src%2F100%25.py");
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
