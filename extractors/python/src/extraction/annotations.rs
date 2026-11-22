//! Pass 6 — annotations and decorators (PLAN.md §23.2). An annotation sets
//! `declaredType` where it names ONE class (`Optional` and a union with `None`
//! unwrapped) and is a `reference` to each class it names; a decorator is an
//! `annotationUse` from the decorated entity to what it names, with its written
//! arguments named the TypeScript way. Each is a site of the summary.

use super::Extractor;
use super::sites::{Landed, Typed};
use crate::declarations::{
    ArgumentDecl, Chain, DecoratorDecl, FunctionDecl, ParameterKind, Span, Target, TypeExpr, ValueDecl,
};
use crate::ids;
use crate::resolve::ModuleRef;
use crate::stdlib_table::Kind;
use codegraph_model::{Key, Literal, NamedArgument};

/// Decorators that shape the entity and the lookup — the language, no edge.
const SHAPING: &[&str] = &[
    "property",
    "cached_property",
    "abstractproperty",
    "staticmethod",
    "classmethod",
    "overload",
];

/// `typing` forms whose first argument is the type: unwrapped for `declaredType`.
const WRAPPERS: &[&str] = &[
    "Optional",
    "ClassVar",
    "Final",
    "Annotated",
    "Required",
    "NotRequired",
    "ReadOnly",
];

impl Extractor<'_> {
    pub(super) fn annotations(&mut self) {
        let files = self.files;
        for (file, decls) in files.iter().enumerate() {
            for (index, function) in decls.functions.iter().enumerate() {
                let Some(key) = self.function_key_of(file, function) else {
                    continue;
                };
                // Every signature names what it names; the entity's types are its primary `def`'s.
                let primary = self.primary[file][index];
                for parameter in &function.parameters {
                    if let Some(annotation) = &parameter.annotation
                        && let Some(declared) = self.annotation(file, function.annotation_scope, annotation, &key)
                        && primary
                    {
                        self.declared_types
                            .insert(ids::parameter_key(&key, &parameter.name), declared);
                    }
                }
                if let Some(returns) = &function.returns
                    && let Some(declared) = self.annotation(file, function.annotation_scope, returns, &key)
                    && primary
                {
                    self.declared_types.insert(key.clone(), declared);
                }
                for decorator in &function.decorators {
                    self.decorator(file, function.scope, decorator, &key, Some(function));
                }
            }
            for class in &decls.classes {
                let Some(key) = self.scope_keys[file][class.body].clone() else {
                    continue;
                };
                for decorator in &class.decorators {
                    self.decorator(file, class.scope, decorator, &key, None);
                }
            }
            for (index, assignment) in decls.assignments.iter().enumerate() {
                let Some(annotation) = &assignment.annotation else {
                    continue;
                };
                let Some(from) = self.scope_keys[file][decls.owner(assignment.scope)].clone() else {
                    continue;
                };
                if let Some(declared) = self.annotation(file, assignment.scope, annotation, &from)
                    && let Some(entity) = self.annotated_binding(file, index)
                {
                    self.declared_types.entry(entity).or_insert(declared);
                }
            }
        }
    }

    fn function_key_of(&self, file: usize, function: &FunctionDecl) -> Option<Key> {
        self.scope_keys[file][function.body].clone()
    }

    /// The variable or attribute an annotated assignment binds: `x: T`, `self.x: T`.
    fn annotated_binding(&self, file: usize, assignment: usize) -> Option<Key> {
        let decls = &self.files[file];
        let decl = &decls.assignments[assignment];
        match &decl.target {
            Target::Name(_) => self.binding_key(file, assignment),
            Target::Attribute { receiver, name } => {
                let crate::declarations::ScopeKind::Function(function) = decls.scopes[decls.owner(decl.scope)].kind
                else {
                    return None;
                };
                let class = self.method_class(file, function)?;
                let first = decls.functions[function].parameters.first()?;
                (first.name == *receiver)
                    .then(|| self.attribute_key(file, class, name))
                    .flatten()
            }
        }
    }

    /// Every class an annotation names, as a `reference` from `from`; the one it is, if one.
    fn annotation(&mut self, file: usize, scope: usize, annotation: &TypeExpr, from: &Key) -> Option<Key> {
        self.references(file, scope, annotation, from);
        self.declared(file, scope, annotation)
    }

    fn references(&mut self, file: usize, scope: usize, annotation: &TypeExpr, from: &Key) {
        match annotation {
            TypeExpr::Named(chain, span) => self.named(file, scope, chain, *span, from),
            TypeExpr::Generic(chain, span, arguments) => {
                self.named(file, scope, chain, *span, from);
                for argument in arguments {
                    self.references(file, scope, argument, from);
                }
            }
            TypeExpr::Union(members) => {
                for member in members {
                    self.references(file, scope, member, from);
                }
            }
            TypeExpr::None | TypeExpr::Other => {}
        }
    }

    /// One name of an annotation: a site, a `reference` when it is a class.
    fn named(&mut self, file: usize, scope: usize, chain: &Chain, span: Span, from: &Key) {
        let typed = match self.quietly(file, scope, chain) {
            Ok(step) if step.read.is_some() => {
                // A `TypeVar`, an alias: a variable the annotation reads, which names no class.
                self.landed(Landed::Language);
                return;
            }
            Ok(step) => step.typed,
            Err(dropped) => {
                self.stats.drop(file, span.0, dropped.reason, dropped.what);
                return;
            }
        };
        match self.annotation_class(typed) {
            Some((to, landed, inferred)) => {
                let provenance = if inferred.is_some() { "derived" } else { "declared" };
                let anchor = self.anchor(file, span);
                if self.edge_with("reference", from, to, provenance, anchor, None, None) {
                    self.count_inference(inferred);
                }
                self.landed(landed);
            }
            None => self.landed(Landed::Language),
        }
    }

    /// The class a typed annotation name is: a corpus class, the table's, or a library name
    /// an annotation makes a class. A builtin, a `typing` form, a module: none.
    fn annotation_class(&mut self, typed: Typed) -> Option<(Key, Landed, Option<&'static str>)> {
        match typed {
            Typed::Corpus {
                file,
                class,
                object: true,
                inferred,
            } => self.class_key(file, class).map(|key| (key, Landed::Corpus, inferred)),
            Typed::External {
                module,
                symbol,
                kind: None | Some(Kind::Class),
                inferred,
            } => {
                let fold = self.external_fold(module, symbol, None);
                let (key, landed) = self.fold_key(&fold);
                Some((key, landed, inferred))
            }
            Typed::Folded { fold, inferred } => {
                let (key, landed) = self.fold_key(&fold);
                Some((key, landed, inferred))
            }
            _ => None,
        }
    }

    /// `declaredType`: the one class an annotation is, `typing` wrappers and `None` unwrapped.
    fn declared(&mut self, file: usize, scope: usize, annotation: &TypeExpr) -> Option<Key> {
        match annotation {
            TypeExpr::Named(chain, _) => self.declared_class(file, scope, chain),
            TypeExpr::Generic(chain, span, arguments) => match self.typing_form(file, scope, chain).as_deref() {
                Some("Union") => self.declared(file, scope, &TypeExpr::Union(arguments.clone())),
                Some(form) if WRAPPERS.contains(&form) => self.declared(file, scope, arguments.first()?),
                _ => self.declared(file, scope, &TypeExpr::Named(chain.clone(), *span)),
            },
            TypeExpr::Union(members) => match members
                .iter()
                .filter(|member| !matches!(member, TypeExpr::None))
                .collect::<Vec<_>>()
                .as_slice()
            {
                [only] => self.declared(file, scope, only),
                _ => None,
            },
            TypeExpr::None | TypeExpr::Other => None,
        }
    }

    fn declared_class(&mut self, file: usize, scope: usize, chain: &Chain) -> Option<Key> {
        let step = self.quietly(file, scope, chain).ok()?;
        if step.read.is_some() {
            return None;
        }
        self.annotation_class(step.typed).map(|(key, _, _)| key)
    }

    /// The name of the `typing` form a subscripted annotation is, if it is one.
    fn typing_form(&mut self, file: usize, scope: usize, chain: &Chain) -> Option<String> {
        match self.quietly(file, scope, chain).ok()?.typed {
            Typed::External {
                module: ModuleRef::Stdlib(module),
                symbol,
                ..
            } if module == "typing" || module == "typing_extensions" => Some(symbol.join(".")),
            _ => None,
        }
    }

    // ----------------------------------------------------------- decorators ----

    fn decorator(
        &mut self,
        file: usize,
        scope: usize,
        decorator: &DecoratorDecl,
        decorated: &Key,
        function: Option<&FunctionDecl>,
    ) {
        let line = decorator.span.0;
        let what = format!("@{}", decorator.text);
        // `@property`, `@x.setter`, `@staticmethod`…: they shape the entity, the language.
        let last = match &decorator.chain {
            Chain::Name(name) | Chain::Attribute(_, name) => Some(name.as_str()),
            _ => None,
        };
        let accessor = function.is_some_and(|function| {
            function.accessor.is_some()
                && matches!(&decorator.chain, Chain::Attribute(owner, word)
                    if Some(word.as_str()) == function.accessor
                        && matches!(owner.as_ref(), Chain::Name(name) if *name == function.name))
        });
        if accessor || last.is_some_and(|name| SHAPING.contains(&name)) {
            self.landed(Landed::Language);
            return;
        }
        let step = match self.quietly(file, scope, &decorator.chain) {
            Ok(step) => step,
            Err(dropped) => {
                let what = format!("{what}{}", dropped.what.strip_prefix(&decorator.text).unwrap_or(""));
                self.stats.drop(file, line, dropped.reason, what);
                return;
            }
        };
        let (to, landed, inferred, parameters) = match (step.read, step.typed) {
            // A decorator held in a variable or an attribute: what it names is that binding.
            (Some((key, inferred)), _) => (key, Landed::Corpus, inferred, Vec::new()),
            (
                None,
                Typed::Function {
                    file: declared,
                    function,
                    inferred,
                },
            ) => match self.function_key(declared, function) {
                Some(key) => {
                    let parameters = positional(&self.files[declared].functions[function], 0);
                    (key, Landed::Corpus, inferred, parameters)
                }
                None => return,
            },
            (
                None,
                Typed::Corpus {
                    file: declared,
                    class,
                    object: true,
                    inferred,
                },
            ) => {
                let Some(key) = self.class_key(declared, class) else {
                    return;
                };
                // A class used as a decorator is called with its `__init__`'s parameters, `self` aside.
                let body = self.files[declared].classes[class].body;
                let parameters = self.files[declared]
                    .functions
                    .iter()
                    .find(|function| function.scope == body && function.name == "__init__")
                    .map(|init| positional(init, 1))
                    .unwrap_or_default();
                (key, Landed::Corpus, inferred, parameters)
            }
            (None, Typed::Folded { fold, inferred }) => {
                let (key, landed) = self.fold_key(&fold);
                (key, landed, inferred, Vec::new())
            }
            (
                None,
                Typed::External {
                    module,
                    symbol,
                    kind,
                    inferred,
                },
            ) => {
                let fold = self.external_fold(module, symbol, kind);
                let (key, landed) = self.fold_key(&fold);
                (key, landed, inferred, Vec::new())
            }
            (None, Typed::Builtin(_) | Typed::Language) => {
                self.landed(Landed::Language);
                return;
            }
            (None, _) => {
                self.stats.drop(file, line, "untyped-receiver", what);
                return;
            }
        };
        let arguments = if decorator.called {
            self.arguments(file, scope, &decorator.arguments, &parameters, &what, line)
        } else {
            Vec::new()
        };
        let provenance = if inferred.is_some() { "derived" } else { "declared" };
        let anchor = self.anchor(file, decorator.span);
        if self.edge_with(
            "annotationUse",
            decorated,
            to,
            provenance,
            anchor,
            None,
            Some(arguments),
        ) {
            self.count_inference(inferred);
        }
        self.landed(landed);
    }

    /// The written arguments, named: a keyword its keyword; a positional one the parameter
    /// it lands on in a corpus decorator, else `arg<i>`. A spread is counted, not written.
    fn arguments(
        &mut self,
        file: usize,
        scope: usize,
        written: &[ArgumentDecl],
        parameters: &[String],
        what: &str,
        line: u32,
    ) -> Vec<NamedArgument> {
        let mut out = Vec::with_capacity(written.len());
        let mut position = 0;
        let mut spread = false;
        for argument in written {
            if argument.spread {
                spread = true;
                continue;
            }
            let name = match &argument.keyword {
                Some(keyword) => keyword.clone(),
                None => {
                    let name = parameters
                        .get(position)
                        .cloned()
                        .unwrap_or_else(|| format!("arg{position}"));
                    position += 1;
                    name
                }
            };
            // An argument recovery made up has no text to be: it is not written.
            if let Some(value) = self.argument_literal(file, scope, &argument.value) {
                out.push(NamedArgument { name, value });
            }
        }
        if spread {
            self.stats.drop(file, line, "spread-argument", what.to_owned());
        }
        out
    }

    /// An argument's value: its literal, else its source text; none where it has no text.
    fn argument_literal(&mut self, file: usize, scope: usize, value: &ValueDecl) -> Option<Literal> {
        if let ValueDecl::Array(items) = value {
            return items
                .iter()
                .map(|item| self.argument_literal(file, scope, item))
                .collect::<Option<Vec<_>>>()
                .map(Literal::Array);
        }
        if let Some(literal) = self.literal(file, scope, value) {
            return Some(literal);
        }
        match value {
            ValueDecl::Code(text) | ValueDecl::Name(_, text) if !text.is_empty() => {
                Some(Literal::Unevaluated(text.clone()))
            }
            _ => None,
        }
    }

    pub(super) fn count_inference(&mut self, inferred: Option<&'static str>) {
        match inferred {
            Some("flow-typed") => self.stats.flow_typed += 1,
            Some("annotation-typed") => self.stats.annotation_typed += 1,
            Some("ancestor-attributed") => self.stats.ancestor_attributed += 1,
            Some("star-attributed") => self.stats.star_attributed += 1,
            Some("alias-base") => self.stats.alias_base += 1,
            _ => {}
        }
    }
}

/// The names a positional argument can land on, `skip` leading ones aside (`self`).
fn positional(function: &FunctionDecl, skip: usize) -> Vec<String> {
    function
        .parameters
        .iter()
        .filter(|parameter| {
            matches!(
                parameter.kind,
                ParameterKind::PositionalOnly | ParameterKind::Positional
            )
        })
        .skip(skip)
        .map(|parameter| parameter.name.clone())
        .collect()
}
