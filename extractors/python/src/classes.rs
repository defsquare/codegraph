//! The class model (PLAN.md §23.4): each corpus class's method resolution
//! order — C3 over corpus classes, the table's classes and library classes no
//! table describes — what each corpus class's own code binds, and what a name
//! read on a class or an instance finds along the order, as the tier the
//! profile's notes give it: a corpus member, the library classes that could
//! answer, the language, a class that decides its members at run time, nothing.

use crate::declarations::{Bound, FileDecls, MethodBinding, Reference, ScopeKind, Synthetic, Target, ValueDecl};
use crate::resolve::{ModuleRef, Resolver, Value};
use crate::scopes;
use crate::stdlib_table::{self, ClassRef, Kind};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const OBJECT: ClassRef = ("builtins", "object");
pub const TYPE: ClassRef = ("builtins", "type");

/// A class as an MRO holds it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ClassId {
    Corpus {
        file: usize,
        class: usize,
    },
    /// A class of the table, where its module declares it: its members are known.
    Table(ClassRef),
    /// A library class no table describes, as written: it could have any member.
    Opaque {
        module: ModuleRef,
        symbol: String,
    },
}

/// What a corpus class's own code binds a name to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnMember {
    /// `functions[i]` of the class's file — a property's getter among them.
    Function(usize),
    /// A nested class, `classes[i]`.
    Class(usize),
    /// Any other binding of its body, or `self.<name> = …` / `cls.<name> = …` in one of its methods.
    Attribute,
}

/// What a name read along an MRO is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Found {
    /// The first corpus class of the order that binds it — the corpus answers first.
    Corpus {
        file: usize,
        class: usize,
        member: OwnMember,
    },
    /// The library classes that could answer, in order; a table class that declares the name ends the list.
    Library(Vec<ClassId>),
    /// `object` (or, on a class object, `type`) declares it, or a builtin class of the order does.
    Language,
    /// Nothing the corpus writes has it, and a class of the order decides its members at run time.
    Dynamic,
    Unbound,
}

/// Where an attribute of a corpus class is bound, in source order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AttributeSites {
    /// The first line that binds it.
    pub line: u32,
    /// Its assignments, `files[file].assignments[i]`: the body's, then each method's `self.<name> = …`.
    pub assignments: Vec<usize>,
}

pub struct Classes {
    /// Per file, per class: its MRO, itself first and `object` last.
    mro: Vec<Vec<Vec<ClassId>>>,
    /// Per file, per class: whether a class of its order decides its members at run time.
    dynamic: Vec<Vec<bool>>,
    /// Per file, per class: what its own code binds, by name.
    members: Vec<Vec<HashMap<String, OwnMember>>>,
    /// Per file, per class: its attributes and where each is bound.
    attributes: Vec<Vec<BTreeMap<String, AttributeSites>>>,
    /// The module and symbol a table class was first written as, as a base: the key its stub takes.
    written: HashMap<ClassRef, (ModuleRef, String)>,
    /// Per file, per class: the classes of its order reached only through a base that is an alias.
    aliased: Vec<Vec<Vec<ClassId>>>,
}

impl Classes {
    pub fn new(files: &[FileDecls], resolver: &Resolver<'_>) -> Self {
        let table = stdlib_table::table();
        let mut written = HashMap::new();
        let mut bases: Vec<Vec<Vec<ClassId>>> = Vec::with_capacity(files.len());
        // Per file, per class: the bases no line names as a class, reached through an alias.
        let mut through: Vec<Vec<Vec<ClassId>>> = Vec::with_capacity(files.len());
        let mut own_dynamic: Vec<Vec<bool>> = Vec::with_capacity(files.len());
        let mut members = Vec::with_capacity(files.len());
        let mut attributes = Vec::with_capacity(files.len());
        for (file, decls) in files.iter().enumerate() {
            let (file_members, file_attributes) = own_members(decls);
            let mut file_bases = Vec::with_capacity(decls.classes.len());
            let mut file_through = Vec::with_capacity(decls.classes.len());
            let mut file_dynamic = Vec::with_capacity(decls.classes.len());
            for (index, class) in decls.classes.iter().enumerate() {
                let mut resolved = Vec::with_capacity(class.bases.len());
                let mut aliases = Vec::new();
                // A base nothing resolves to a class may be anything: so may what the class holds.
                let mut dynamic = class.metaclass
                    || ["__getattr__", "__getattribute__"]
                        .iter()
                        .any(|name| matches!(file_members[index].get(*name), Some(OwnMember::Function(_))));
                if let Some(synthetic) = &class.synthetic {
                    match synthetic_base(file, class.scope, synthetic, resolver) {
                        Some(id) => resolved.push(id),
                        None => dynamic = true,
                    }
                }
                for base in &class.bases {
                    if let Reference::Synthetic(synthetic) = &base.reference {
                        match synthetic_base(file, class.scope, synthetic, resolver) {
                            Some(id) => resolved.push(id),
                            None => dynamic = true,
                        }
                        continue;
                    }
                    let Reference::Dotted(names) = &base.reference else {
                        dynamic = true;
                        continue;
                    };
                    let mut value = resolver.base(file, index, names).value;
                    let mut alias = false;
                    if let Value::Assigned { .. } = value
                        && let Some(target) = through_aliases(files, resolver, value.clone())
                    {
                        value = target;
                        alias = true;
                    }
                    match class_of(&value) {
                        Some(id) => {
                            if alias {
                                aliases.push(id.clone());
                            }
                            if let (ClassId::Table(class), Value::External { module, symbol, .. }) = (&id, &value) {
                                written
                                    .entry(*class)
                                    .or_insert_with(|| (module.clone(), symbol.join(".")));
                            }
                            resolved.push(id);
                        }
                        None => dynamic = true,
                    }
                }
                file_bases.push(resolved);
                file_through.push(aliases);
                file_dynamic.push(dynamic);
            }
            bases.push(file_bases);
            through.push(file_through);
            own_dynamic.push(file_dynamic);
            members.push(file_members);
            attributes.push(file_attributes);
        }
        let mut linearizer = Linearizer {
            bases: &bases,
            memo: HashMap::new(),
            visiting: HashSet::new(),
        };
        let mut mro = Vec::with_capacity(files.len());
        let mut dynamic = Vec::with_capacity(files.len());
        let mut aliased = Vec::with_capacity(files.len());
        for (file, decls) in files.iter().enumerate() {
            let mut file_mro = Vec::with_capacity(decls.classes.len());
            let mut file_dynamic = Vec::with_capacity(decls.classes.len());
            let mut file_aliased = Vec::with_capacity(decls.classes.len());
            for class in 0..decls.classes.len() {
                let order = linearizer.order(&ClassId::Corpus { file, class });
                // What a written base leads to, transitively; the rest of the order an alias brought.
                let mut reach: HashSet<ClassId> =
                    HashSet::from([ClassId::Corpus { file, class }, ClassId::Table(OBJECT)]);
                let mut pending = vec![ClassId::Corpus { file, class }];
                while let Some(id) = pending.pop() {
                    let next: Vec<ClassId> = match &id {
                        ClassId::Corpus { file, class } => bases[*file][*class]
                            .iter()
                            .filter(|base| !through[*file][*class].contains(base))
                            .cloned()
                            .collect(),
                        ClassId::Table(class) => table.bases(*class).into_iter().map(ClassId::Table).collect(),
                        ClassId::Opaque { .. } => Vec::new(),
                    };
                    for base in next {
                        if reach.insert(base.clone()) {
                            pending.push(base);
                        }
                    }
                }
                file_aliased.push(order.iter().filter(|id| !reach.contains(id)).cloned().collect());
                let runs = order.iter().any(|id| match id {
                    ClassId::Corpus { file, class } => own_dynamic[*file][*class],
                    ClassId::Table(class) => {
                        *class != OBJECT && *class != TYPE && table.member(*class, "__getattr__").is_some()
                    }
                    ClassId::Opaque { .. } => false,
                });
                file_dynamic.push(runs);
                file_mro.push(order);
            }
            mro.push(file_mro);
            dynamic.push(file_dynamic);
            aliased.push(file_aliased);
        }
        Classes {
            mro,
            dynamic,
            members,
            attributes,
            written,
            aliased,
        }
    }

    pub fn mro(&self, file: usize, class: usize) -> &[ClassId] {
        &self.mro[file][class]
    }

    pub fn is_dynamic(&self, file: usize, class: usize) -> bool {
        self.dynamic[file][class]
    }

    pub fn member(&self, file: usize, class: usize, name: &str) -> Option<OwnMember> {
        self.members[file][class].get(name).copied()
    }

    /// Whether `ancestor` is in the class's order only because a base is an alias: what it
    /// answers rests on that inference.
    pub fn through_alias(&self, file: usize, class: usize, ancestor: &ClassId) -> bool {
        self.aliased[file][class].contains(ancestor)
    }

    /// An enumeration: a class of the `enum` module stands in its order.
    pub fn is_enum(&self, file: usize, class: usize) -> bool {
        self.mro(file, class)
            .iter()
            .any(|id| matches!(id, ClassId::Table((module, _)) if *module == "enum"))
    }

    pub fn attributes(&self, file: usize, class: usize) -> &BTreeMap<String, AttributeSites> {
        &self.attributes[file][class]
    }

    /// How a table class is keyed: as a base first wrote it, else below the module that declares it.
    pub fn written(&self, class: ClassRef) -> Option<&(ModuleRef, String)> {
        self.written.get(&class)
    }

    /// `name` read along `order` (an MRO, or its tail after `super()`); `class_object` when
    /// the receiver is the class itself, so `type`'s members are the language too.
    pub fn find(&self, order: &[ClassId], dynamic: bool, name: &str, class_object: bool) -> Found {
        let table = stdlib_table::table();
        // A `def` or a nested class anywhere in the order holds the key over an attribute (the
        // profile's key rule); else the first corpus class that binds the name.
        let corpus = order.iter().filter_map(|id| match id {
            ClassId::Corpus { file, class } => self.member(*file, *class, name).map(|member| Found::Corpus {
                file: *file,
                class: *class,
                member,
            }),
            _ => None,
        });
        let mut first = None;
        for found in corpus {
            if !matches!(
                found,
                Found::Corpus {
                    member: OwnMember::Attribute,
                    ..
                }
            ) {
                return found;
            }
            first.get_or_insert(found);
        }
        if let Some(found) = first {
            return found;
        }
        let mut could = Vec::new();
        for id in order {
            match id {
                ClassId::Corpus { .. } => {}
                ClassId::Table(class) if *class == OBJECT => {}
                ClassId::Table(class) => {
                    if table.member(*class, name).is_some() {
                        could.push(id.clone());
                        break;
                    }
                }
                ClassId::Opaque { .. } => could.push(id.clone()),
            }
        }
        let language = |id: &ClassId| matches!(id, ClassId::Table((module, _)) if *module == "builtins");
        match could.as_slice() {
            [] => {
                if table.member(OBJECT, name).is_some() || (class_object && table.member(TYPE, name).is_some()) {
                    Found::Language
                } else if dynamic {
                    Found::Dynamic
                } else {
                    Found::Unbound
                }
            }
            // What a table class declares is found before `__getattr__` is ever asked.
            [only] if language(only) => Found::Language,
            [ClassId::Table(_)] => Found::Library(could),
            _ if dynamic => Found::Dynamic,
            _ => Found::Library(could),
        }
    }
}

/// What a module- or class-level name bound EXACTLY ONCE to another name holds, aliases
/// followed (cycle-guarded): `None` where a binding in the chain is a call, a literal, bound
/// twice, or local. A value that is no assignment is itself.
pub fn through_aliases(files: &[FileDecls], resolver: &Resolver<'_>, value: Value) -> Option<Value> {
    let mut seen = HashSet::new();
    let mut value = value;
    while let Value::Assigned { file, assignment } = value {
        if !seen.insert((file, assignment)) {
            return None;
        }
        let decls = &files[file];
        let decl = &decls.assignments[assignment];
        let Target::Name(name) = &decl.target else {
            return None;
        };
        if !matches!(decls.scopes[decl.scope].kind, ScopeKind::Module | ScopeKind::Class(_)) {
            return None;
        }
        let once = matches!(scopes::bound_in(decls, decl.scope, name).as_slice(),
            [only] if only.bound == Bound::Assigned(assignment));
        let Some(ValueDecl::Name(chain, _)) = &decl.value else {
            return None;
        };
        if !once || decl.augmented {
            return None;
        }
        value = resolver.reference(file, decl.scope, &chain.dotted()?).value;
    }
    Some(value)
}

/// The class a resolved base is, when it is one.
pub fn class_of(value: &Value) -> Option<ClassId> {
    let table = stdlib_table::table();
    match value {
        Value::Class { file, class } => Some(ClassId::Corpus {
            file: *file,
            class: *class,
        }),
        Value::Builtin {
            name,
            kind: Kind::Class,
        } => table.class("builtins", name).map(ClassId::Table),
        Value::External { module, symbol, kind } => {
            if let (ModuleRef::Stdlib(dotted), [name]) = (module, symbol.as_slice())
                && let Some(class) = table.class(dotted, name)
            {
                return Some(ClassId::Table(class));
            }
            match kind {
                Some(Kind::Function | Kind::Value | Kind::Module(_)) => None,
                _ => Some(ClassId::Opaque {
                    module: module.clone(),
                    symbol: symbol.join("."),
                }),
            }
        }
        _ => None,
    }
}

/// The base the interpreter gives a class a standard form makes — `tuple` for a named tuple,
/// `dict` for a typed dict, the `Enum` called — once the callee is the standard library's.
pub fn synthetic_base(file: usize, scope: usize, synthetic: &Synthetic, resolver: &Resolver<'_>) -> Option<ClassId> {
    let table = stdlib_table::table();
    let names = synthetic.callee.dotted()?;
    let value = resolver.reference(file, scope, &names).value;
    let Value::External {
        module: ModuleRef::Stdlib(_),
        symbol,
        ..
    } = &value
    else {
        return None;
    };
    if symbol.last().map(String::as_str) != Some(synthetic.form) {
        return None;
    }
    match synthetic.form {
        "namedtuple" | "NamedTuple" => table.class("builtins", "tuple").map(ClassId::Table),
        "TypedDict" => table.class("builtins", "dict").map(ClassId::Table),
        _ => class_of(&value),
    }
}

/// What each class of a file binds itself, and its attributes with where they are bound.
#[allow(clippy::type_complexity)]
fn own_members(decls: &FileDecls) -> (Vec<HashMap<String, OwnMember>>, Vec<BTreeMap<String, AttributeSites>>) {
    let mut members: Vec<HashMap<String, OwnMember>> = vec![HashMap::new(); decls.classes.len()];
    let mut attributes: Vec<BTreeMap<String, AttributeSites>> = vec![BTreeMap::new(); decls.classes.len()];
    let mut note = |class: usize, name: &str, line: u32, assignment: Option<usize>| {
        let sites = attributes[class]
            .entry(name.to_owned())
            .or_insert_with(|| AttributeSites {
                line,
                assignments: Vec::new(),
            });
        sites.line = sites.line.min(line);
        sites.assignments.extend(assignment);
    };
    for (index, class) in decls.classes.iter().enumerate() {
        for binding in &decls.scopes[class.body].bindings {
            let own = match binding.bound {
                Bound::Function(function) => OwnMember::Function(function),
                Bound::Class(nested) => OwnMember::Class(nested),
                Bound::Assigned(assignment) => {
                    note(index, &binding.name, binding.line, Some(assignment));
                    OwnMember::Attribute
                }
                Bound::Import { .. } | Bound::Value | Bound::Parameter { .. } => {
                    note(index, &binding.name, binding.line, None);
                    OwnMember::Attribute
                }
            };
            // A `def` or a `class` wins the name over any other binding; the first of them wins.
            let entry = members[index].entry(binding.name.clone()).or_insert(own);
            if *entry == OwnMember::Attribute && own != OwnMember::Attribute {
                *entry = own;
            }
        }
    }
    // `self.<name> = …` (`cls.<name>`) in a method, a lambda or comprehension of it included.
    for (assignment, decl) in decls.assignments.iter().enumerate() {
        let Target::Attribute { receiver, name } = &decl.target else {
            continue;
        };
        let ScopeKind::Function(function) = decls.scopes[decls.owner(decl.scope)].kind else {
            continue;
        };
        let method = &decls.functions[function];
        let ScopeKind::Class(class) = decls.scopes[method.scope].kind else {
            continue;
        };
        let first = method.parameters.first().map(|parameter| parameter.name.as_str());
        if method.binding == MethodBinding::Static || first != Some(receiver.as_str()) {
            continue;
        }
        note(class, name, decl.span.0, Some(assignment));
        members[class].entry(name.clone()).or_insert(OwnMember::Attribute);
    }
    for sites in attributes.iter_mut().flat_map(|class| class.values_mut()) {
        sites
            .assignments
            .sort_by_key(|assignment| decls.assignments[*assignment].span);
    }
    (members, attributes)
}

/// C3 over the resolved bases, memoized; every order ends with `object`.
struct Linearizer<'a> {
    bases: &'a [Vec<Vec<ClassId>>],
    memo: HashMap<ClassId, Vec<ClassId>>,
    visiting: HashSet<ClassId>,
}

impl Linearizer<'_> {
    fn order(&mut self, id: &ClassId) -> Vec<ClassId> {
        if let Some(done) = self.memo.get(id) {
            return done.clone();
        }
        self.visiting.insert(id.clone());
        let object = ClassId::Table(OBJECT);
        let mut bases: Vec<ClassId> = match id {
            ClassId::Corpus { file, class } => self.bases[*file][*class].clone(),
            ClassId::Table(class) => stdlib_table::table()
                .bases(*class)
                .into_iter()
                .map(ClassId::Table)
                .collect(),
            ClassId::Opaque { .. } => Vec::new(),
        };
        // A base that inherits from the class being ordered is no base it can have.
        bases.retain(|base| !self.visiting.contains(base));
        if bases.is_empty() && *id != object {
            bases.push(object.clone());
        }
        let mut sequences: Vec<Vec<ClassId>> = bases.iter().map(|base| self.order(base)).collect();
        sequences.push(bases.clone());
        let tail = merge(sequences.clone()).unwrap_or_else(|| {
            // Python refuses the class; the model keeps the bases' orders in their written order.
            let mut seen = HashSet::new();
            let mut out: Vec<ClassId> = sequences[..sequences.len() - 1]
                .iter()
                .flatten()
                .filter(|class| **class != object && seen.insert((*class).clone()))
                .cloned()
                .collect();
            out.push(object.clone());
            out
        });
        let mut out = Vec::with_capacity(tail.len() + 1);
        out.push(id.clone());
        out.extend(tail.into_iter().filter(|class| class != id));
        self.visiting.remove(id);
        self.memo.insert(id.clone(), out.clone());
        out
    }
}

/// C3's merge: the first head no sequence holds in its tail, until none is left.
fn merge(mut sequences: Vec<Vec<ClassId>>) -> Option<Vec<ClassId>> {
    let mut out = Vec::new();
    loop {
        sequences.retain(|sequence| !sequence.is_empty());
        if sequences.is_empty() {
            return Some(out);
        }
        let head = sequences
            .iter()
            .map(|sequence| &sequence[0])
            .find(|candidate| !sequences.iter().any(|sequence| sequence[1..].contains(candidate)))?
            .clone();
        for sequence in &mut sequences {
            if sequence[0] == head {
                sequence.remove(0);
            }
        }
        out.push(head);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus;
    use crate::declarations::declarations;
    use crate::resolve::Modules;

    struct World {
        corpus: corpus::Corpus,
        files: Vec<FileDecls>,
    }

    impl World {
        fn new(sources: &[(&str, &str)]) -> Self {
            let corpus = corpus::from_sources(sources);
            let files = corpus
                .files
                .iter()
                .map(|file| declarations(&file.text, &file.line_starts))
                .collect();
            World { corpus, files }
        }

        fn with<T>(&self, run: impl FnOnce(&Classes, &dyn Fn(&str, &str) -> (usize, usize)) -> T) -> T {
            let modules = Modules::new(&self.corpus);
            let resolver = Resolver::new(&modules, &self.files);
            let classes = Classes::new(&self.files, &resolver);
            let find = |rel: &str, name: &str| {
                let file = self.corpus.files.iter().position(|f| f.rel == rel).expect(rel);
                let class = self.files[file]
                    .classes
                    .iter()
                    .position(|c| c.name == name)
                    .expect(name);
                (file, class)
            };
            run(&classes, &find)
        }
    }

    fn corpus(file: usize, class: usize) -> ClassId {
        ClassId::Corpus { file, class }
    }

    #[test]
    fn orders_a_diamond_by_c3_and_ends_every_order_with_object() {
        let world = World::new(&[(
            "m.py",
            "class A: pass\nclass B(A): pass\nclass C(A): pass\nclass D(B, C): pass\n",
        )]);
        world.with(|classes, at| {
            let (file, d) = at("m.py", "D");
            assert_eq!(
                classes.mro(file, d),
                &[
                    corpus(file, 3),
                    corpus(file, 1),
                    corpus(file, 2),
                    corpus(file, 0),
                    ClassId::Table(OBJECT)
                ]
            );
            assert_eq!(classes.mro(file, 0), &[corpus(file, 0), ClassId::Table(OBJECT)]);
        });
    }

    #[test]
    fn a_member_is_the_first_corpus_class_of_the_order_that_binds_it_a_def_before_an_attribute() {
        let world = World::new(&[(
            "m.py",
            "class A:\n    limit = 3\n    def total(self): pass\n    def __init__(self):\n        self.lines = []\n        self.total = 0\n\
             class B(A):\n    @classmethod\n    def make(cls):\n        cls.registry = {}\n",
        )]);
        world.with(|classes, at| {
            let (file, a) = at("m.py", "A");
            let (_, b) = at("m.py", "B");
            assert_eq!(classes.member(file, a, "total"), Some(OwnMember::Function(0)));
            assert_eq!(classes.member(file, a, "limit"), Some(OwnMember::Attribute));
            assert_eq!(classes.member(file, a, "lines"), Some(OwnMember::Attribute));
            assert_eq!(classes.member(file, b, "registry"), Some(OwnMember::Attribute));
            let order = classes.mro(file, b);
            assert_eq!(
                classes.find(order, false, "lines", false),
                Found::Corpus {
                    file,
                    class: a,
                    member: OwnMember::Attribute
                }
            );
            // `self.total = 0` binds a name a `def` holds: the def is the member.
            assert_eq!(
                classes.find(order, false, "total", false),
                Found::Corpus {
                    file,
                    class: a,
                    member: OwnMember::Function(0)
                }
            );
            let lines = &classes.attributes(file, a)["lines"];
            assert_eq!((lines.line, lines.assignments.len()), (5, 1));
            assert_eq!(classes.find(order, false, "nothing", false), Found::Unbound);
            assert_eq!(classes.find(order, false, "__class__", false), Found::Language);
            assert_eq!(classes.find(order, false, "__name__", true), Found::Language);
        });
    }

    #[test]
    fn a_def_anywhere_in_the_order_holds_the_name_over_an_attribute_a_subclass_writes() {
        let world = World::new(&[(
            "m.py",
            "class Base:\n    @property\n    def size(self): pass\n\
             class Sub(Base):\n    def __init__(self):\n        self.size = 2\n",
        )]);
        world.with(|classes, at| {
            let (file, sub) = at("m.py", "Sub");
            let (_, base) = at("m.py", "Base");
            assert_eq!(classes.member(file, sub, "size"), Some(OwnMember::Attribute));
            assert_eq!(
                classes.find(classes.mro(file, sub), false, "size", false),
                Found::Corpus {
                    file,
                    class: base,
                    member: OwnMember::Function(0)
                }
            );
        });
    }

    #[test]
    fn a_table_class_answers_exactly_and_a_library_class_no_table_describes_could_answer_anything() {
        let world = World::new(&[(
            "m.py",
            "import unittest\nfrom django.db import models\nfrom mixins import Audit\n\
             class T(unittest.TestCase): pass\nclass O(models.Model): pass\nclass Both(Audit, models.Model): pass\n\
             class E(ValueError): pass\nclass Mixed(Audit, unittest.TestCase): pass\n",
        )]);
        world.with(|classes, at| {
            let (file, t) = at("m.py", "T");
            let test_case = ClassId::Table(("unittest.case", "TestCase"));
            assert_eq!(classes.mro(file, t)[1], test_case);
            assert_eq!(
                classes.written(("unittest.case", "TestCase")),
                Some(&(ModuleRef::Stdlib("unittest".into()), "TestCase".into()))
            );
            let find = |name: &str, member: &str| {
                let (file, class) = at("m.py", name);
                classes.find(classes.mro(file, class), classes.is_dynamic(file, class), member, false)
            };
            assert_eq!(find("T", "assertEqual"), Found::Library(vec![test_case.clone()]));
            let model = ClassId::Opaque {
                module: ModuleRef::Site("django.db".into()),
                symbol: "models.Model".into(),
            };
            let audit = ClassId::Opaque {
                module: ModuleRef::Site("mixins".into()),
                symbol: "Audit".into(),
            };
            assert_eq!(find("O", "objects"), Found::Library(vec![model.clone()]));
            assert_eq!(find("Both", "objects"), Found::Library(vec![audit.clone(), model]));
            // A builtin class's member is the language; an opaque class before a table class could shadow it.
            assert_eq!(find("E", "args"), Found::Language);
            assert_eq!(find("Mixed", "assertEqual"), Found::Library(vec![audit, test_case]));
            assert_eq!(find("T", "nothing_declares_this"), Found::Unbound);
        });
    }

    #[test]
    fn a_class_that_decides_its_members_at_run_time_makes_nothing_declares_it_no_evidence() {
        let world = World::new(&[(
            "m.py",
            "from lib import Base, Meta\nclass Proxy:\n    def __getattr__(self, name): pass\n\
             class Sub(Proxy): pass\nclass Made(metaclass=Meta): pass\nclass Computed(make_base()): pass\n\
             class Valued(Base): pass\nclass Plain: pass\nclass Listy(list):\n    def __getattr__(self, name): pass\n",
        )]);
        world.with(|classes, at| {
            for name in ["Proxy", "Sub", "Made", "Computed"] {
                let (file, class) = at("m.py", name);
                assert!(classes.is_dynamic(file, class), "{name}");
                assert_eq!(
                    classes.find(classes.mro(file, class), true, "anything", false),
                    Found::Dynamic,
                    "{name}"
                );
            }
            let (file, plain) = at("m.py", "Plain");
            assert!(!classes.is_dynamic(file, plain));
            // One library class that could answer, still: the run-time member may be its.
            let (_, valued) = at("m.py", "Valued");
            assert!(!classes.is_dynamic(file, valued));
            // What a table class declares is found before `__getattr__` is ever asked.
            let (_, listy) = at("m.py", "Listy");
            assert_eq!(
                classes.find(classes.mro(file, listy), true, "append", false),
                Found::Language
            );
        });
    }

    #[test]
    fn a_base_cycle_and_an_inconsistent_order_still_end_in_an_order() {
        let world = World::new(&[
            ("a.py", "from b import B\nclass A(B): pass\n"),
            ("b.py", "from a import A\nclass B(A): pass\n"),
            ("c.py", "class X: pass\nclass Y(X): pass\nclass Z(X, Y): pass\n"),
        ]);
        world.with(|classes, at| {
            let (a, class) = at("a.py", "A");
            assert_eq!(classes.mro(a, class).last(), Some(&ClassId::Table(OBJECT)));
            let (c, z) = at("c.py", "Z");
            // Python refuses `Z(X, Y)`; the model keeps the bases in their written order.
            assert_eq!(
                classes.mro(c, z),
                &[corpus(c, 2), corpus(c, 0), corpus(c, 1), ClassId::Table(OBJECT)]
            );
        });
    }

    #[test]
    fn a_resolved_base_is_a_class_only_when_it_names_one() {
        assert_eq!(
            class_of(&Value::Builtin {
                name: "dict".into(),
                kind: Kind::Class
            }),
            Some(ClassId::Table(("builtins", "dict")))
        );
        assert_eq!(
            class_of(&Value::External {
                module: ModuleRef::Stdlib("os".into()),
                symbol: vec!["getcwd".into()],
                kind: Some(Kind::Function)
            }),
            None
        );
        assert_eq!(class_of(&Value::Opaque), None);
    }
}
