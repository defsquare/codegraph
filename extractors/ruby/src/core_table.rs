//! The embedded table of what the Ruby VM defines before any file runs — the
//! ct.sym of this extractor: constants, their ancestry, their methods.
//! Generated from RBS `core/` at a pinned version by `tools/core-table` and
//! committed, so a model says which standard it resolved against and no Ruby
//! is needed to build or run the binary.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const TABLE: &str = include_str!("../data/core-rbs-4.2.0.tsv");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoreKind {
    Class,
    Module,
    /// A value constant (`ARGV`, `Float::INFINITY`): known, and not a type.
    Constant,
}

/// What every object answers, whatever its class: calling one of these is
/// using the language, not depending on a type.
const EVERY_OBJECT: &[&str] = &["Object", "Kernel", "BasicObject"];
/// What every class and module answers on top of that (`new`, `name`,
/// `attr_accessor`, `private`, `include`).
const EVERY_CLASS: &[&str] = &["Class", "Module"];

pub struct CoreTable {
    version: &'static str,
    kinds: HashMap<&'static str, CoreKind>,
    supers: HashMap<&'static str, &'static str>,
    includes: HashMap<&'static str, Vec<&'static str>>,
    instance: HashSet<(&'static str, &'static str)>,
    singleton: HashSet<(&'static str, &'static str)>,
}

impl CoreTable {
    /// The RBS release the table was distilled from.
    pub fn version(&self) -> &'static str {
        self.version
    }

    pub fn kind(&self, fqn: &str) -> Option<CoreKind> {
        self.kinds.get(fqn).copied()
    }

    pub fn contains(&self, fqn: &str) -> bool {
        self.kinds.contains_key(fqn)
    }

    pub fn len(&self) -> usize {
        self.kinds.len()
    }

    pub fn is_empty(&self) -> bool {
        self.kinds.is_empty()
    }

    /// A core type's own name, with the table's lifetime.
    pub fn name(&self, fqn: &str) -> Option<&'static str> {
        self.kinds.get_key_value(fqn).map(|(name, _)| *name)
    }

    /// A core class or module and what its instances inherit from, nearest
    /// first: itself, its mixins, then its superclass's.
    pub fn ancestors(&self, fqn: &str) -> Vec<&'static str> {
        let mut out = Vec::new();
        let mut current = self.name(fqn);
        while let Some(class) = current {
            if out.contains(&class) {
                break;
            }
            out.push(class);
            for mixin in self.includes.get(class).into_iter().flatten().rev() {
                if !out.contains(mixin) {
                    out.push(mixin);
                }
            }
            current = self
                .supers
                .get(class)
                .copied()
                .filter(|superclass| !superclass.is_empty());
        }
        out
    }

    /// A core class and its superclasses, nearest first.
    pub fn superclasses(&self, fqn: &str) -> Vec<&'static str> {
        let mut out = Vec::new();
        let mut current = self.name(fqn);
        while let Some(class) = current {
            if out.contains(&class) {
                break;
            }
            out.push(class);
            current = self
                .supers
                .get(class)
                .copied()
                .filter(|superclass| !superclass.is_empty());
        }
        out
    }

    /// Whether `owner` itself — not an ancestor — defines the instance method.
    pub fn defines_instance(&self, owner: &str, name: &str) -> bool {
        self.instance.contains(&(owner, name))
    }

    /// Whether `owner` itself defines the singleton method.
    pub fn defines_singleton(&self, owner: &str, name: &str) -> bool {
        self.singleton.contains(&(owner, name))
    }

    /// The core class or module, among `fqn`'s ancestors, that defines the instance method.
    pub fn instance_method(&self, fqn: &str, name: &str) -> Option<&'static str> {
        self.ancestors(fqn)
            .into_iter()
            .find(|owner| self.instance.contains(&(owner, name)))
    }

    /// The core class or module that answers `fqn.name`: a singleton method of
    /// the class or of a superclass, else what every class or module answers.
    pub fn singleton_method(&self, fqn: &str, name: &str) -> Option<&'static str> {
        let mut current = self.name(fqn);
        while let Some(class) = current {
            if self.singleton.contains(&(class, name)) {
                return Some(class);
            }
            current = self
                .supers
                .get(class)
                .copied()
                .filter(|superclass| !superclass.is_empty());
        }
        let metaclass = if self.kind(fqn) == Some(CoreKind::Module) {
            "Module"
        } else {
            "Class"
        };
        self.instance_method(metaclass, name)
    }

    /// Whether a method defined by `owner` is one every object (or, for a
    /// class-level call, every class) answers.
    pub fn is_language(owner: &str, on_class: bool) -> bool {
        EVERY_OBJECT.contains(&owner) || (on_class && EVERY_CLASS.contains(&owner))
    }
}

pub fn table() -> &'static CoreTable {
    static CORE: OnceLock<CoreTable> = OnceLock::new();
    CORE.get_or_init(|| parse(TABLE))
}

fn parse(text: &'static str) -> CoreTable {
    let mut lines = text.lines();
    // `# rbs 4.2.0 core/ — generated by …`
    let version = lines
        .next()
        .and_then(|header| header.strip_prefix("# rbs "))
        .and_then(|rest| rest.split(' ').next())
        .expect("the core table starts with its RBS version");
    let mut table = CoreTable {
        version,
        kinds: HashMap::new(),
        supers: HashMap::new(),
        includes: HashMap::new(),
        instance: HashSet::new(),
        singleton: HashSet::new(),
    };
    for line in lines {
        let mut fields = line.split('\t');
        let (Some(record), Some(name)) = (fields.next(), fields.next()) else {
            continue;
        };
        let third = fields.next();
        match (record, third) {
            ("class", superclass) => {
                table.kinds.insert(name, CoreKind::Class);
                table.supers.insert(name, superclass.unwrap_or(""));
            }
            ("module", _) => {
                table.kinds.insert(name, CoreKind::Module);
            }
            ("const", _) => {
                table.kinds.insert(name, CoreKind::Constant);
            }
            ("include", Some(module)) => table.includes.entry(name).or_default().push(module),
            ("def", Some(method)) => {
                table.instance.insert((name, method));
            }
            ("sdef", Some(method)) => {
                table.singleton.insert((name, method));
            }
            (other, _) => panic!("core table: unknown record {other:?}"),
        }
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_what_the_vm_defines_and_with_what_kind() {
        let core = table();
        assert_eq!(core.version(), "4.2.0");
        assert_eq!(core.kind("String"), Some(CoreKind::Class));
        assert_eq!(core.kind("StandardError"), Some(CoreKind::Class));
        assert_eq!(core.kind("Comparable"), Some(CoreKind::Module));
        assert_eq!(core.kind("Kernel"), Some(CoreKind::Module));
        assert_eq!(core.kind("File::Stat"), Some(CoreKind::Class));
        assert_eq!(core.kind("Errno::ENOENT"), Some(CoreKind::Class));
        assert_eq!(core.kind("ARGV"), Some(CoreKind::Constant));
        assert!(core.len() > 800);
    }

    #[test]
    fn leaves_the_standard_library_out_on_purpose() {
        // Default and bundled gems: they need a `require`, and the set moves
        // with every Ruby release. They are `<gems>`, never `<ruby>`.
        for library in ["JSON", "Date", "Logger", "Forwardable", "BigDecimal", "Net::HTTP"] {
            assert!(!table().contains(library), "{library}");
        }
        // RBS's own helper namespace is not something a VM defines.
        assert!(!table().contains("RBS"));
    }

    #[test]
    fn linearizes_a_core_class_as_ruby_does() {
        let core = table();
        assert_eq!(
            core.ancestors("String"),
            vec!["String", "Comparable", "Object", "Kernel", "BasicObject"]
        );
        assert_eq!(
            core.ancestors("RuntimeError"),
            vec![
                "RuntimeError",
                "StandardError",
                "Exception",
                "Object",
                "Kernel",
                "BasicObject"
            ]
        );
        // A module has no Object above it: whoever mixes it in brings that.
        assert_eq!(core.ancestors("Comparable"), vec!["Comparable"]);
        assert!(core.ancestors("Nope").is_empty());
    }

    #[test]
    fn finds_the_ancestor_that_defines_a_method() {
        let core = table();
        assert_eq!(core.instance_method("String", "upcase"), Some("String"));
        assert_eq!(core.instance_method("String", "between?"), Some("Comparable"));
        assert_eq!(core.instance_method("String", "puts"), Some("Kernel"));
        assert_eq!(core.instance_method("Array", "each_slice"), Some("Enumerable"));
        assert_eq!(core.instance_method("RuntimeError", "message"), Some("Exception"));
        assert_eq!(core.instance_method("String", "blank?"), None);
        // A singleton method is inherited down the class chain…
        assert_eq!(core.singleton_method("File", "read"), Some("IO"));
        assert_eq!(core.singleton_method("Time", "now"), Some("Time"));
        // …and every class answers what `Class` and `Module` define.
        assert_eq!(core.singleton_method("String", "new"), Some("Class"));
        assert_eq!(core.singleton_method("String", "attr_accessor"), Some("Module"));
        assert_eq!(core.singleton_method("Comparable", "private"), Some("Module"));
        assert_eq!(core.singleton_method("String", "has_many"), None);
    }

    #[test]
    fn tells_the_language_from_a_type_one_depends_on() {
        assert!(CoreTable::is_language("Kernel", false));
        assert!(CoreTable::is_language("BasicObject", false));
        assert!(!CoreTable::is_language("Comparable", false));
        assert!(!CoreTable::is_language("String", false));
        // `new`, `private`, `attr_reader` are the language only for a class-level call.
        assert!(CoreTable::is_language("Module", true));
        assert!(!CoreTable::is_language("Module", false));
    }
}
