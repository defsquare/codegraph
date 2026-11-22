//! Pass 5 — the sites (PLAN.md §23.4): every name, attribute, call, write,
//! `raise` and `except` a body holds, as an edge, a count or a drop. A chain
//! is ONE site whose outcome is its last step; an attribute or a variable read
//! on the way is an `access` of its own. A receiver's class is written
//! (`declared`) or inferred (`derived`, counted by the inference), and a
//! library's class or module takes every step below it.

use super::Extractor;
use crate::classes::{ClassId, Found, OwnMember};
use crate::declarations::{
    Bound, Chain, MethodBinding, Reference, ScopeKind, Site, SiteKind, Target, TypeExpr, ValueDecl,
};
use crate::resolve::{ModuleRef, Value};
use crate::scopes;
use crate::stdlib_table::{self, Kind};
use codegraph_model::{Anchor, Key};

/// The inference a `derived` edge rests on, by its counter; `None` for a fact.
pub(super) type Inferred = Option<&'static str>;

/// What a value is, as far as the reader can say without running it.
#[derive(Clone, Debug)]
pub(super) enum Typed {
    /// A module, and the inference that made the value one (`m = import_module("a.b")`).
    Module(ModuleRef, Inferred),
    /// A corpus class: the class itself (`object`), or one of its instances.
    Corpus {
        file: usize,
        class: usize,
        object: bool,
        inferred: Inferred,
    },
    /// `super()`: the order after the class it is written in, `of`.
    Super {
        order: Vec<ClassId>,
        dynamic: bool,
        of: (usize, usize),
    },
    /// A corpus `def` as a value: a function, or a method looked up on a class or an instance.
    Function {
        file: usize,
        function: usize,
        inferred: Inferred,
    },
    /// A library's class or module, which takes every step below it.
    Folded { fold: Fold, inferred: Inferred },
    /// A name below a library module, as written: a class on evidence, else its module's.
    External {
        module: ModuleRef,
        symbol: Vec<String>,
        kind: Option<Kind>,
        inferred: Inferred,
    },
    /// A name of `builtins`.
    Builtin(String),
    /// An instance of a builtin class, a literal: the language.
    Language,
    /// A value no line types: a parameter, a local bound twice, a call's result, a subscript.
    Untyped,
}

/// A library entity a site lands on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Fold {
    /// A class of an MRO: the table's, or one no table describes.
    Class(ClassId),
    /// A class as a site writes it, below the module it was imported from.
    Written {
        module: ModuleRef,
        symbol: String,
    },
    Module(ModuleRef),
}

/// Where a resolved site landed, for the summary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Landed {
    Corpus,
    Builtins,
    Stdlib,
    Site,
    Missing,
    Language,
    /// A local, a module: read, and nothing to count.
    Nothing,
}

/// A site that names nothing the model can point at.
pub(super) struct Dropped {
    pub(super) reason: &'static str,
    pub(super) what: String,
}

fn dropped(reason: &'static str, what: impl Into<String>) -> Dropped {
    Dropped {
        reason,
        what: what.into(),
    }
}

/// A chain evaluated: its value, and the attribute or variable it was read from.
#[derive(Clone, Debug)]
pub(super) struct Step {
    pub(super) typed: Typed,
    pub(super) read: Option<(Key, Inferred)>,
}

fn step(typed: Typed) -> Step {
    Step { typed, read: None }
}

/// The site being resolved: where its names are read, which entity runs it, where it is written.
struct Ctx<'s> {
    file: usize,
    scope: usize,
    from: Key,
    anchor: Anchor,
    site: &'s Site,
    /// Write edges; `false` while a binding is typed, which emits nothing.
    emit: bool,
}

impl Extractor<'_> {
    /// What makes a name no table describes a CLASS: a site inherits from it, raises or
    /// catches it, or annotates with it. Without it, a library name folds to its module.
    pub(super) fn evidence(&mut self) {
        let files = self.files;
        for (file, decls) in files.iter().enumerate() {
            for (index, class) in decls.classes.iter().enumerate() {
                for base in &class.bases {
                    if let Reference::Dotted(names) = &base.reference {
                        let value = self.resolver.base(file, index, names).value;
                        let value = match value {
                            Value::Assigned { .. } => {
                                crate::classes::through_aliases(self.files, self.resolver, value.clone())
                                    .unwrap_or(value)
                            }
                            value => value,
                        };
                        self.note_evidence(value);
                    }
                }
            }
            for site in &decls.sites {
                let named: Vec<&Chain> = match &site.kind {
                    SiteKind::Raise { handler } => handler.iter().chain([&site.chain]).collect(),
                    SiteKind::Except => vec![&site.chain],
                    _ => continue,
                };
                for chain in named {
                    let chain = match chain {
                        Chain::Call(callee) => callee.as_ref(),
                        other => other,
                    };
                    if let Some(names) = chain.dotted() {
                        let value = self.resolver.reference(file, site.scope, &names).value;
                        self.note_evidence(value);
                    }
                }
            }
            for function in &decls.functions {
                let annotations = function
                    .parameters
                    .iter()
                    .filter_map(|parameter| parameter.annotation.as_ref())
                    .chain(function.returns.as_ref());
                for annotation in annotations {
                    self.note_annotation(file, function.annotation_scope, annotation);
                }
            }
            for assignment in &decls.assignments {
                if let Some(annotation) = &assignment.annotation {
                    self.note_annotation(file, assignment.scope, annotation);
                }
            }
        }
    }

    fn note_evidence(&mut self, value: Value) {
        if let Value::External {
            module,
            symbol,
            kind: None,
        } = value
        {
            self.evidence.insert((module, symbol.join(".")));
        }
    }

    fn note_annotation(&mut self, file: usize, scope: usize, annotation: &TypeExpr) {
        match annotation {
            TypeExpr::Named(chain, _) | TypeExpr::Generic(chain, _, _) => {
                if let Some(names) = chain.dotted() {
                    let value = self.resolver.reference(file, scope, &names).value;
                    self.note_evidence(value);
                }
                if let TypeExpr::Generic(_, _, arguments) = annotation {
                    for argument in self.type_arguments(file, scope, chain, arguments) {
                        self.note_annotation(file, scope, argument);
                    }
                }
            }
            TypeExpr::Union(members) => {
                for member in members {
                    self.note_annotation(file, scope, member);
                }
            }
            TypeExpr::None | TypeExpr::Other => {}
        }
    }

    /// Every site of every body.
    pub(super) fn sites(&mut self) {
        let files = self.files;
        for (file, decls) in files.iter().enumerate() {
            for site in &decls.sites {
                let from = match site.class {
                    Some(class) => self.class_key(file, class),
                    None => self.scope_keys[file][decls.owner(site.scope)].clone(),
                };
                let Some(from) = from else {
                    continue;
                };
                let ctx = Ctx {
                    file,
                    scope: site.scope,
                    from,
                    anchor: self.anchor(file, site.span),
                    site,
                    emit: true,
                };
                match self.outcome(&ctx) {
                    Ok(landed) => self.landed(landed),
                    Err(Dropped { reason, what }) => self.stats.drop(file, site.span.0, reason, what),
                }
            }
        }
    }

    pub(super) fn landed(&mut self, landed: Landed) {
        let stats = &mut self.stats;
        match landed {
            Landed::Corpus => stats.resolved_corpus += 1,
            Landed::Builtins => stats.resolved_builtins += 1,
            Landed::Stdlib => stats.resolved_stdlib += 1,
            Landed::Site => stats.resolved_site += 1,
            Landed::Missing => stats.resolved_missing += 1,
            Landed::Language => stats.language += 1,
            Landed::Nothing => {}
        }
    }

    fn outcome(&mut self, ctx: &Ctx<'_>) -> Result<Landed, Dropped> {
        let site = ctx.site;
        match &site.kind {
            SiteKind::Load => match &site.chain {
                Chain::Call(callee) => {
                    let callee = self.eval(ctx, callee)?;
                    self.invoke(ctx, callee).map(|(landed, _)| landed)
                }
                Chain::Name(name) if self.is_local(ctx, name) => Ok(Landed::Nothing),
                chain => {
                    let read = self.eval(ctx, chain)?;
                    self.read(ctx, read)
                }
            },
            SiteKind::Store { augmented } => self.store(ctx, &site.chain, *augmented),
            SiteKind::Raise { handler } if !handler.is_empty() => {
                let mut landed = Landed::Nothing;
                for chain in handler {
                    landed = self.throw(ctx, chain)?;
                }
                Ok(landed)
            }
            SiteKind::Raise { .. } => self.throw(ctx, &site.chain),
            SiteKind::Except => {
                let caught = self.eval(ctx, &site.chain)?;
                match self.exception(ctx, &caught.typed) {
                    Some((to, landed, inferred)) => {
                        self.emit(ctx, "reference", to, inferred, None);
                        Ok(landed)
                    }
                    None => self.read(ctx, caught),
                }
            }
        }
    }

    // ---------------------------------------------------------------- reads ----

    /// A bare name a function binds and no line types: read, and nothing to say.
    fn is_local(&self, ctx: &Ctx<'_>, name: &str) -> bool {
        match self.resolver.reference(ctx.file, ctx.scope, &[name.to_owned()]).value {
            Value::Parameter { .. } | Value::Opaque => true,
            Value::Assigned { file, assignment } => {
                let scope = self.files[file].assignments[assignment].scope;
                !matches!(
                    self.files[file].scopes[scope].kind,
                    ScopeKind::Module | ScopeKind::Class(_)
                )
            }
            _ => false,
        }
    }

    /// The last step read, not called.
    fn read(&mut self, ctx: &Ctx<'_>, read: Step) -> Result<Landed, Dropped> {
        if let Some((key, inferred)) = read.read {
            self.emit(ctx, "access", key, inferred, Some((true, false)));
            return Ok(Landed::Corpus);
        }
        match read.typed {
            Typed::Corpus {
                file,
                class,
                object: true,
                inferred,
            } => match self.class_key(file, class) {
                Some(to) => {
                    self.emit(ctx, "reference", to, inferred, None);
                    Ok(Landed::Corpus)
                }
                None => Ok(Landed::Nothing),
            },
            Typed::Function {
                file,
                function,
                inferred,
            } => match self.function_key(file, function) {
                Some(to) => {
                    self.emit(ctx, "reference", to, inferred, None);
                    Ok(Landed::Corpus)
                }
                None => Ok(Landed::Nothing),
            },
            Typed::Folded { fold, inferred } => {
                let (to, landed) = self.fold_key(&fold);
                self.emit(ctx, "reference", to, inferred, None);
                Ok(landed)
            }
            Typed::External {
                module,
                symbol,
                kind,
                inferred,
            } => {
                let fold = self.external_fold(module, symbol, kind);
                let (to, landed) = self.fold_key(&fold);
                self.emit(ctx, "reference", to, inferred, None);
                Ok(landed)
            }
            Typed::Builtin(_) | Typed::Language => Ok(Landed::Language),
            Typed::Module(..) | Typed::Corpus { .. } | Typed::Super { .. } | Typed::Untyped => Ok(Landed::Nothing),
        }
    }

    // ---------------------------------------------------------------- calls ----

    /// What calling a value does: the edge, where it landed, and what the call returns.
    fn invoke(&mut self, ctx: &Ctx<'_>, callee: Step) -> Result<(Landed, Typed), Dropped> {
        // A value read from an attribute or a variable: the read is what the model knows.
        if let Some((key, inferred)) = callee.read {
            self.emit(ctx, "access", key, inferred, Some((true, false)));
            return Ok((Landed::Corpus, Typed::Untyped));
        }
        match callee.typed {
            Typed::Corpus {
                file,
                class,
                object: true,
                inferred,
            } => {
                // `Order(…)` is `Order.__init__` where a corpus class of the order writes one.
                let order = self.classes.mro(file, class).to_vec();
                let (to, init_inferred) = match self.classes.find(&order, false, "__init__", false) {
                    Found::Corpus {
                        file: owner,
                        class: owner_class,
                        member: OwnMember::Function(function),
                    } => (
                        self.function_key(owner, function),
                        self.through_alias(Some((file, class)), owner, owner_class, inferred),
                    ),
                    _ => (None, inferred),
                };
                if let Some(to) = to.or_else(|| self.class_key(file, class)) {
                    self.emit(ctx, "invocation", to, init_inferred, None);
                }
                let instance = Typed::Corpus {
                    file,
                    class,
                    object: false,
                    inferred,
                };
                Ok((Landed::Corpus, instance))
            }
            Typed::Corpus {
                file,
                class,
                object: false,
                inferred,
            } => {
                let order = self.classes.mro(file, class).to_vec();
                let dynamic = self.classes.is_dynamic(file, class);
                let call = self.member(ctx, &order, dynamic, "__call__", false, inferred, false, file, class)?;
                self.invoke(ctx, call)
            }
            Typed::Function {
                file,
                function,
                inferred,
            } => {
                if let Some(to) = self.function_key(file, function) {
                    self.emit(ctx, "invocation", to, inferred, None);
                }
                let returns = self.returns(file, function);
                Ok((Landed::Corpus, returns))
            }
            Typed::Folded { fold, inferred } => {
                let (to, landed) = self.fold_key(&fold);
                self.emit(ctx, "invocation", to, inferred, None);
                Ok((landed, Typed::Folded { fold, inferred }))
            }
            Typed::External {
                module,
                symbol,
                kind,
                inferred,
            } => {
                let fold = self.external_fold(module, symbol, kind);
                let (to, landed) = self.fold_key(&fold);
                self.emit(ctx, "invocation", to, inferred, None);
                Ok((landed, Typed::Folded { fold, inferred }))
            }
            Typed::Builtin(_) | Typed::Language => Ok((Landed::Language, Typed::Language)),
            Typed::Module(..) | Typed::Super { .. } | Typed::Untyped => {
                Err(dropped("untyped-receiver", ctx.site.text.clone()))
            }
        }
    }

    /// What a corpus `def`'s return annotation says it returns.
    fn returns(&mut self, file: usize, function: usize) -> Typed {
        let decl = &self.files[file].functions[function];
        match &decl.returns {
            Some(annotation) => self
                .annotated(file, decl.annotation_scope, annotation)
                .unwrap_or(Typed::Untyped),
            None => Typed::Untyped,
        }
    }

    // --------------------------------------------------------------- writes ----

    fn store(&mut self, ctx: &Ctx<'_>, chain: &Chain, augmented: bool) -> Result<Landed, Dropped> {
        let access = Some((augmented, true));
        match chain {
            // `global x` then `x = …`: the module's variable.
            Chain::Name(name) => match self
                .resolver
                .reference(ctx.file, ctx.scope, std::slice::from_ref(name))
                .value
            {
                Value::Assigned { file, assignment } => match self.binding_key(file, assignment) {
                    Some(key) => {
                        self.emit(ctx, "access", key, None, access);
                        Ok(Landed::Corpus)
                    }
                    None => Ok(Landed::Nothing),
                },
                _ => Ok(Landed::Nothing),
            },
            Chain::Attribute(inner, name) => {
                let receiver = self.receiver(ctx, inner)?;
                let self_receiver = self.is_self(ctx, inner);
                let written = match receiver.typed {
                    Typed::Corpus {
                        file,
                        class,
                        object,
                        inferred,
                    } => {
                        let order = self.classes.mro(file, class).to_vec();
                        let dynamic = self.classes.is_dynamic(file, class);
                        // A property is written through its setter.
                        if let Found::Corpus {
                            file: owner,
                            class: owner_class,
                            member: OwnMember::Function(function),
                        } = self.classes.find(&order, dynamic, name, object)
                            && self.files[owner].functions[function].property
                        {
                            let to = self
                                .setter(owner, owner_class, name)
                                .or_else(|| self.function_key(owner, function));
                            let inferred = self.through_alias(Some((file, class)), owner, owner_class, inferred);
                            if let Some(to) = to {
                                self.emit(ctx, "access", to, inferred, access);
                            }
                            return Ok(Landed::Corpus);
                        }
                        self.member(ctx, &order, dynamic, name, object, inferred, self_receiver, file, class)?
                    }
                    typed => self.attribute(ctx, typed, name, self_receiver)?,
                };
                self.write(ctx, written, access)
            }
            _ => Ok(Landed::Nothing),
        }
    }

    fn write(&mut self, ctx: &Ctx<'_>, written: Step, access: Option<(bool, bool)>) -> Result<Landed, Dropped> {
        if let Some((key, inferred)) = written.read {
            self.emit(ctx, "access", key, inferred, access);
            return Ok(Landed::Corpus);
        }
        match written.typed {
            Typed::Folded { fold, inferred } => {
                let (to, landed) = self.fold_key(&fold);
                self.emit(ctx, "access", to, inferred, access);
                Ok(landed)
            }
            Typed::External {
                module,
                symbol,
                kind,
                inferred,
            } => {
                let fold = self.external_fold(module, symbol, kind);
                let (to, landed) = self.fold_key(&fold);
                self.emit(ctx, "access", to, inferred, access);
                Ok(landed)
            }
            Typed::Builtin(_) | Typed::Language => Ok(Landed::Language),
            // A method or a class rebound from outside: monkey patching, which the model does not hold.
            _ => Ok(Landed::Nothing),
        }
    }

    // --------------------------------------------------------------- raises ----

    fn throw(&mut self, ctx: &Ctx<'_>, chain: &Chain) -> Result<Landed, Dropped> {
        let raised = match chain {
            // `raise Foo(…)`: constructing it is a call of its own.
            Chain::Call(callee) => {
                let callee = self.eval(ctx, callee)?;
                if let Typed::Corpus { object: true, .. } = callee.typed {
                    self.invoke(ctx, callee.clone())?;
                }
                callee
            }
            Chain::Name(_) | Chain::Attribute(..) => self.eval(ctx, chain)?,
            _ => return Err(dropped("raise-of-a-value", ctx.site.text.clone())),
        };
        match self.exception(ctx, &raised.typed) {
            Some((to, landed, inferred)) => {
                self.emit(ctx, "throws", to, inferred, None);
                Ok(landed)
            }
            None => Err(dropped("raise-of-a-value", ctx.site.text.clone())),
        }
    }

    /// The class a `raise` or an `except` names: a name of `builtins` is a stub here.
    fn exception(&mut self, ctx: &Ctx<'_>, typed: &Typed) -> Option<(Key, Landed, Inferred)> {
        let _ = ctx;
        match typed {
            Typed::Corpus {
                file,
                class,
                object: true,
                inferred,
            } => self
                .class_key(*file, *class)
                .map(|key| (key, Landed::Corpus, *inferred)),
            Typed::Builtin(name) => {
                let module = self.stubs.builtins();
                Some((self.stubs.type_below(module, name), Landed::Builtins, None))
            }
            Typed::Folded {
                fold: fold @ (Fold::Class(_) | Fold::Written { .. }),
                inferred,
            } => {
                let (key, landed) = self.fold_key(fold);
                Some((key, landed, *inferred))
            }
            Typed::External {
                module,
                symbol,
                inferred,
                ..
            } => {
                // Raised or caught: a class, by the evidence pass.
                let fold = Fold::Written {
                    module: module.clone(),
                    symbol: symbol.join("."),
                };
                let (key, landed) = self.fold_key(&fold);
                Some((key, landed, *inferred))
            }
            _ => None,
        }
    }

    // ----------------------------------------------------------- evaluation ----

    /// A receiver: the chain evaluated, and the attribute or variable it was read from, accessed.
    fn receiver(&mut self, ctx: &Ctx<'_>, chain: &Chain) -> Result<Step, Dropped> {
        let receiver = self.eval(ctx, chain)?;
        if let Some((key, inferred)) = &receiver.read {
            self.emit(ctx, "access", key.clone(), *inferred, Some((true, false)));
        }
        Ok(receiver)
    }

    fn eval(&mut self, ctx: &Ctx<'_>, chain: &Chain) -> Result<Step, Dropped> {
        match chain {
            Chain::Name(name) => self.name(ctx, name),
            Chain::Attribute(inner, name) => {
                let receiver = self.receiver(ctx, inner)?;
                let self_receiver = self.is_self(ctx, inner);
                self.attribute(ctx, receiver.typed, name, self_receiver)
            }
            Chain::Call(callee) => {
                let callee = self.eval(ctx, callee)?;
                let (_, returned) = self.invoke(ctx, callee)?;
                Ok(step(returned))
            }
            Chain::Super(named) => Ok(step(self.super_of(ctx, named.as_deref()))),
            Chain::Literal(_) => Ok(step(Typed::Language)),
            Chain::Other => Ok(step(Typed::Untyped)),
        }
    }

    fn name(&mut self, ctx: &Ctx<'_>, name: &str) -> Result<Step, Dropped> {
        let resolved = self.resolver.reference(ctx.file, ctx.scope, &[name.to_owned()]);
        let inferred = resolved.star_attributed.then_some("star-attributed");
        self.value(ctx, resolved.value, inferred)
    }

    /// What a resolved name is, as a step.
    fn value(&mut self, ctx: &Ctx<'_>, value: Value, inferred: Inferred) -> Result<Step, Dropped> {
        Ok(step(match value {
            Value::Class { file, class } => Typed::Corpus {
                file,
                class,
                object: true,
                inferred,
            },
            Value::Function { file, function } => Typed::Function {
                file,
                function,
                inferred,
            },
            Value::Module(module) => Typed::Module(module, inferred),
            Value::External { module, symbol, kind } => Typed::External {
                module,
                symbol,
                kind,
                inferred,
            },
            Value::Builtin { name, .. } => Typed::Builtin(name),
            Value::Assigned { file, assignment } => {
                let typed = self.binding_type(file, assignment);
                return Ok(Step {
                    typed,
                    read: self.binding_key(file, assignment).map(|key| (key, inferred)),
                });
            }
            Value::Parameter { file, function, index } => self.parameter(file, function, index),
            Value::Opaque => Typed::Untyped,
            Value::Unbound { cycle } => {
                let what = if cycle {
                    format!("{} (an import cycle)", ctx.site.text)
                } else {
                    ctx.site.text.clone()
                };
                return Err(dropped("unbound-name", what));
            }
            Value::AmbiguousStar(modules) => {
                return Err(dropped(
                    "ambiguous-star",
                    format!("{} ({})", ctx.site.text, modules.join(" or ")),
                ));
            }
        }))
    }

    /// `receiver.name`.
    fn attribute(&mut self, ctx: &Ctx<'_>, receiver: Typed, name: &str, self_receiver: bool) -> Result<Step, Dropped> {
        match receiver {
            Typed::Module(module, inferred) => {
                let value = self.resolver.module_member(ctx.file, &module, name);
                self.value(ctx, value, inferred)
            }
            Typed::Corpus {
                file,
                class,
                object,
                inferred,
            } => {
                let order = self.classes.mro(file, class).to_vec();
                let dynamic = self.classes.is_dynamic(file, class);
                self.member(ctx, &order, dynamic, name, object, inferred, self_receiver, file, class)
            }
            Typed::Super { order, dynamic, of } => {
                self.member_of_order(ctx, &order, dynamic, name, false, None, true, None, Some(of))
            }
            Typed::Folded { fold, inferred } => Ok(step(Typed::Folded { fold, inferred })),
            Typed::External {
                module,
                mut symbol,
                kind,
                inferred,
            } => {
                let fold = self.external_fold(module.clone(), symbol.clone(), kind);
                Ok(step(match fold {
                    // Below a library class or a module's function or value: the library's.
                    Fold::Module(_) if kind.is_none() => {
                        symbol.push(name.to_owned());
                        Typed::External {
                            module,
                            symbol,
                            kind: None,
                            inferred,
                        }
                    }
                    fold => Typed::Folded { fold, inferred },
                }))
            }
            Typed::Builtin(_) | Typed::Language => Ok(step(Typed::Language)),
            Typed::Function { .. } | Typed::Untyped => Err(dropped("untyped-receiver", ctx.site.text.clone())),
        }
    }

    /// `name` along a corpus class's order.
    #[allow(clippy::too_many_arguments)]
    fn member(
        &mut self,
        ctx: &Ctx<'_>,
        order: &[ClassId],
        dynamic: bool,
        name: &str,
        object: bool,
        inferred: Inferred,
        self_receiver: bool,
        file: usize,
        class: usize,
    ) -> Result<Step, Dropped> {
        self.member_of_order(
            ctx,
            order,
            dynamic,
            name,
            object,
            inferred,
            self_receiver,
            Some((file, class)),
            Some((file, class)),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn member_of_order(
        &mut self,
        ctx: &Ctx<'_>,
        order: &[ClassId],
        dynamic: bool,
        name: &str,
        object: bool,
        inferred: Inferred,
        self_receiver: bool,
        receiver: Option<(usize, usize)>,
        of: Option<(usize, usize)>,
    ) -> Result<Step, Dropped> {
        let class_name = || {
            receiver
                .or_else(|| match order.first() {
                    Some(ClassId::Corpus { file, class }) => Some((*file, *class)),
                    _ => None,
                })
                .map(|(file, class)| self.files[file].classes[class].name.clone())
                .unwrap_or_default()
        };
        let found = self.classes.find(order, dynamic, name, object);
        // What an ancestor brought in only by an alias answers rests on that inference.
        let inferred = match &found {
            Found::Corpus { file, class, .. } => self.through_alias(of, *file, *class, inferred),
            _ => inferred,
        };
        match found {
            Found::Corpus { file, class, member } => Ok(match member {
                OwnMember::Function(function) if self.files[file].functions[function].property && !object => {
                    // A property is read as an attribute: an access of its getter.
                    let returns = self.returns(file, function);
                    Step {
                        typed: returns,
                        read: self.function_key(file, function).map(|key| (key, inferred)),
                    }
                }
                OwnMember::Function(function) => step(Typed::Function {
                    file,
                    function,
                    inferred,
                }),
                OwnMember::Class(nested) => step(Typed::Corpus {
                    file,
                    class: nested,
                    object: true,
                    inferred,
                }),
                OwnMember::Attribute => {
                    let key = self.attribute_key(file, class, name);
                    let typed = self.attribute_type(file, class, name);
                    Step {
                        typed,
                        read: key.map(|key| (key, inferred)),
                    }
                }
            }),
            Found::Library(could) => match could.as_slice() {
                [only] => Ok(step(Typed::Folded {
                    fold: Fold::Class(only.clone()),
                    inferred: inferred.or(Some("ancestor-attributed")),
                })),
                several => {
                    let names: Vec<String> = several.iter().map(|id| self.class_name(id)).collect();
                    Err(dropped(
                        "ambiguous-ancestor",
                        format!("{} ({})", ctx.site.text, names.join(" or ")),
                    ))
                }
            },
            Found::Language => Ok(step(Typed::Language)),
            Found::Dynamic => Err(dropped(
                "unbound-dynamic",
                format!("{} ({})", ctx.site.text, class_name()),
            )),
            Found::Unbound => {
                let reason = if self_receiver {
                    "unbound-self-call"
                } else {
                    "unbound-attribute"
                };
                Err(dropped(reason, format!("{} ({})", ctx.site.text, class_name())))
            }
        }
    }

    /// The inference a member rests on: the receiver's, else the alias that brought its class in.
    fn through_alias(&self, of: Option<(usize, usize)>, file: usize, class: usize, inferred: Inferred) -> Inferred {
        match of {
            Some((of_file, of_class))
                if self
                    .classes
                    .through_alias(of_file, of_class, &ClassId::Corpus { file, class }) =>
            {
                inferred.or(Some("alias-base"))
            }
            _ => inferred,
        }
    }

    /// `self` or `cls` — the first parameter of a method — or `super()`.
    fn is_self(&self, ctx: &Ctx<'_>, chain: &Chain) -> bool {
        match chain {
            Chain::Super(_) => true,
            Chain::Name(name) => matches!(
                self.resolver.reference(ctx.file, ctx.scope, std::slice::from_ref(name)).value,
                Value::Parameter { file, function, index: 0 } if self.method_class(file, function).is_some()
            ),
            _ => false,
        }
    }

    /// The class a `def` is a method of, unless it is a `@staticmethod`.
    pub(super) fn method_class(&self, file: usize, function: usize) -> Option<usize> {
        let decl = &self.files[file].functions[function];
        match self.files[file].scopes[decl.scope].kind {
            ScopeKind::Class(class) if decl.binding != MethodBinding::Static => Some(class),
            _ => None,
        }
    }

    fn parameter(&mut self, file: usize, function: usize, index: usize) -> Typed {
        if index == 0
            && let Some(class) = self.method_class(file, function)
        {
            let object = self.files[file].functions[function].binding == MethodBinding::Class;
            return Typed::Corpus {
                file,
                class,
                object,
                inferred: None,
            };
        }
        let decl = &self.files[file].functions[function];
        match decl
            .parameters
            .get(index)
            .and_then(|parameter| parameter.annotation.as_ref())
        {
            Some(annotation) => self
                .annotated(file, decl.annotation_scope, annotation)
                .unwrap_or(Typed::Untyped),
            None => Typed::Untyped,
        }
    }

    /// `super()` / `super(C, self)`: the order of the class after it.
    fn super_of(&mut self, ctx: &Ctx<'_>, named: Option<&str>) -> Typed {
        let decls = &self.files[ctx.file];
        let class = match named {
            Some(name) => match self.resolver.reference(ctx.file, ctx.scope, &[name.to_owned()]).value {
                Value::Class { file, class } => Some((file, class)),
                _ => None,
            },
            None => {
                // The class whose body holds the nearest enclosing method.
                let mut scope = Some(ctx.scope);
                let mut found = None;
                while let Some(index) = scope {
                    if let ScopeKind::Function(function) = decls.scopes[index].kind
                        && let ScopeKind::Class(class) = decls.scopes[decls.functions[function].scope].kind
                    {
                        found = Some((ctx.file, class));
                        break;
                    }
                    scope = decls.scopes[index].parent;
                }
                found
            }
        };
        match class {
            Some((file, class)) => Typed::Super {
                order: self.classes.mro(file, class)[1..].to_vec(),
                dynamic: self.classes.is_dynamic(file, class),
                of: (file, class),
            },
            None => Typed::Untyped,
        }
    }

    // --------------------------------------------------------------- typing ----

    /// What a module's or a function's name bound by one assignment holds: an annotation,
    /// else what the assignment constructs or names (flow), else nothing typed.
    fn binding_type(&mut self, file: usize, assignment: usize) -> Typed {
        let decl = &self.files[file].assignments[assignment];
        let Target::Name(name) = &decl.target else {
            return Typed::Untyped;
        };
        let bindings = scopes::bound_in(&self.files[file], decl.scope, name);
        if !matches!(bindings.as_slice(), [only] if only.bound == Bound::Assigned(assignment)) {
            return Typed::Untyped;
        }
        self.assignment_type(file, assignment)
    }

    fn assignment_type(&mut self, file: usize, assignment: usize) -> Typed {
        if !self.typing.insert((file, assignment)) {
            return Typed::Untyped;
        }
        let decl = &self.files[file].assignments[assignment];
        let scope = decl.scope;
        let typed = if let Some(annotation) = &decl.annotation {
            self.annotated(file, scope, annotation).unwrap_or(Typed::Untyped)
        } else if let Some(callee) = &decl.constructed {
            let typed = self.quiet(file, scope, callee).map(|step| step.typed);
            // `importlib.import_module("a.b")` is `a.b`; `__import__("a.b")` is `a`, as the interpreter returns it.
            let imported = match &typed {
                Some(Typed::External {
                    module: ModuleRef::Stdlib(module),
                    symbol,
                    ..
                }) if module == "importlib" && symbol == &["import_module"] => Some(false),
                Some(Typed::Builtin(name)) if name == "__import__" => Some(true),
                _ => None,
            };
            if let Some(top) = imported {
                let typed = match decl.literal.as_deref().filter(|dotted| super::is_module_name(dotted)) {
                    Some(dotted) => {
                        let dotted = if top {
                            dotted.split('.').next().unwrap_or(dotted)
                        } else {
                            dotted
                        };
                        match self.resolver.modules.absolute(file, dotted) {
                            crate::resolve::Lookup::Found { module, .. } => Typed::Module(module, Some("flow-typed")),
                            _ => Typed::Untyped,
                        }
                    }
                    None => Typed::Untyped,
                };
                self.typing.remove(&(file, assignment));
                return typed;
            }
            match typed {
                Some(Typed::Corpus {
                    file,
                    class,
                    object: true,
                    ..
                }) => Typed::Corpus {
                    file,
                    class,
                    object: false,
                    inferred: Some("flow-typed"),
                },
                Some(Typed::External {
                    module, symbol, kind, ..
                }) => Typed::Folded {
                    // A class, or what a library's module makes: the library's either way.
                    fold: self.external_fold(module, symbol, kind),
                    inferred: Some("flow-typed"),
                },
                Some(Typed::Builtin(_)) => Typed::Language,
                _ => Typed::Untyped,
            }
        } else {
            match &decl.value {
                Some(ValueDecl::Name(chain, _)) => match self.quiet(file, scope, chain).map(|step| step.typed) {
                    Some(Typed::Corpus {
                        file, class, object, ..
                    }) => Typed::Corpus {
                        file,
                        class,
                        object,
                        inferred: Some("flow-typed"),
                    },
                    _ => Typed::Untyped,
                },
                Some(
                    ValueDecl::Str(_)
                    | ValueDecl::Number(_)
                    | ValueDecl::Bool(_)
                    | ValueDecl::Array(_)
                    | ValueDecl::Pairs(..),
                ) => Typed::Language,
                _ => Typed::Untyped,
            }
        };
        self.typing.remove(&(file, assignment));
        typed
    }

    /// An attribute's type: annotated anywhere, else one class every assignment constructs.
    fn attribute_type(&mut self, file: usize, class: usize, name: &str) -> Typed {
        let Some(key) = self.attribute_key(file, class, name) else {
            return Typed::Untyped;
        };
        let assignments = self.attribute_assignments.get(&key).cloned().unwrap_or_default();
        let mut found: Option<Typed> = None;
        for (file, assignment) in &assignments {
            if self.files[*file].assignments[*assignment].annotation.is_some() {
                return self.assignment_type(*file, *assignment);
            }
        }
        for (file, assignment) in assignments {
            let typed = self.assignment_type(file, assignment);
            let same = match (&found, &typed) {
                (None, _) => true,
                (Some(Typed::Corpus { file: a, class: b, .. }), Typed::Corpus { file: c, class: d, .. }) => {
                    (a, b) == (c, d)
                }
                (Some(Typed::Folded { fold: a, .. }), Typed::Folded { fold: b, .. }) => a == b,
                (Some(Typed::Language), Typed::Language) => true,
                _ => false,
            };
            if !same || matches!(typed, Typed::Untyped) {
                return Typed::Untyped;
            }
            found = Some(typed);
        }
        found.unwrap_or(Typed::Untyped)
    }

    /// The instance an annotation names when it names one class: `Optional` and a union with
    /// `None` unwrapped, anything wider untyped; `annotation-typed`.
    fn annotated(&mut self, file: usize, scope: usize, annotation: &TypeExpr) -> Option<Typed> {
        let inferred = Some("annotation-typed");
        match annotation {
            TypeExpr::Named(chain, _) => match self.quiet(file, scope, chain)?.typed {
                Typed::Corpus { file, class, .. } => Some(Typed::Corpus {
                    file,
                    class,
                    object: false,
                    inferred,
                }),
                Typed::External { module, symbol, .. } => Some(Typed::Folded {
                    fold: Fold::Written {
                        module,
                        symbol: symbol.join("."),
                    },
                    inferred,
                }),
                Typed::Builtin(_) => Some(Typed::Language),
                _ => None,
            },
            TypeExpr::Generic(chain, span, arguments) => {
                let typing = match self.quiet(file, scope, chain)?.typed {
                    Typed::External { module, symbol, .. } if super::annotations::is_typing(&module) => {
                        symbol.join(".")
                    }
                    _ => String::new(),
                };
                match typing.as_str() {
                    "Optional" => self.annotated(file, scope, arguments.first()?),
                    "Union" => self.annotated(file, scope, &TypeExpr::Union(arguments.clone())),
                    _ => self.annotated(file, scope, &TypeExpr::Named(chain.clone(), *span)),
                }
            }
            TypeExpr::Union(members) => match members
                .iter()
                .filter(|member| !matches!(member, TypeExpr::None))
                .collect::<Vec<_>>()
                .as_slice()
            {
                [only] => self.annotated(file, scope, only),
                _ => None,
            },
            TypeExpr::None | TypeExpr::Other => None,
        }
    }

    /// A chain evaluated where a binding is written, writing nothing.
    fn quiet(&mut self, file: usize, scope: usize, chain: &Chain) -> Option<Step> {
        self.quietly(file, scope, chain).ok()
    }

    /// The same, saying why it named nothing.
    pub(super) fn quietly(&mut self, file: usize, scope: usize, chain: &Chain) -> Result<Step, Dropped> {
        let site = Site {
            scope,
            chain: chain.clone(),
            kind: SiteKind::Load,
            literal: None,
            span: (0, 0),
            text: String::new(),
            class: None,
        };
        let ctx = Ctx {
            file,
            scope,
            from: self.file_keys[file].clone(),
            anchor: self.anchor(file, (1, 1)),
            site: &site,
            emit: false,
        };
        let text = chain.dotted().map(|names| names.join(".")).unwrap_or_default();
        self.eval(&ctx, chain).map_err(|dropped| Dropped {
            what: if dropped.what.is_empty() { text } else { dropped.what },
            ..dropped
        })
    }

    // ----------------------------------------------------------------- keys ----

    pub(super) fn class_key(&self, file: usize, class: usize) -> Option<Key> {
        self.scope_keys[file][self.files[file].classes[class].body].clone()
    }

    pub(super) fn function_key(&self, file: usize, function: usize) -> Option<Key> {
        self.scope_keys[file][self.files[file].functions[function].body].clone()
    }

    /// A property's `@<name>.setter`, written in the class that owns the getter.
    fn setter(&self, file: usize, class: usize, name: &str) -> Option<Key> {
        let body = self.files[file].classes[class].body;
        self.files[file]
            .functions
            .iter()
            .find(|function| function.scope == body && function.name == name && function.accessor == Some("setter"))
            .and_then(|function| self.scope_keys[file][function.body].clone())
    }

    pub(super) fn attribute_key(&self, file: usize, class: usize, name: &str) -> Option<Key> {
        self.attribute_keys.get(&(file, class, name.to_owned())).cloned()
    }

    /// The variable or the attribute an assignment at a module's or a class body's top binds.
    pub(super) fn binding_key(&self, file: usize, assignment: usize) -> Option<Key> {
        let decl = &self.files[file].assignments[assignment];
        let Target::Name(name) = &decl.target else {
            return None;
        };
        let scope = &self.files[file].scopes[decl.scope];
        match scope.kind {
            ScopeKind::Module => self.variable_keys.get(&(file, name.clone())).cloned(),
            ScopeKind::Class(class) => self.attribute_key(file, class, name),
            // `global x` in a function: the module's.
            _ if scope.globals.iter().any(|global| global == name) => {
                self.variable_keys.get(&(file, name.clone())).cloned()
            }
            _ => None,
        }
    }

    /// A name below a library module, as written: a class when the table says so or a site
    /// gives the evidence; a function or a value folds to its module.
    pub(super) fn external_fold(&self, module: ModuleRef, symbol: Vec<String>, kind: Option<Kind>) -> Fold {
        let table = stdlib_table::table();
        if let (ModuleRef::Stdlib(dotted), [name]) = (&module, symbol.as_slice())
            && table.class(dotted, name).is_some()
        {
            return Fold::Written {
                module,
                symbol: name.clone(),
            };
        }
        let symbol = symbol.join(".");
        match kind {
            None if self.evidence.contains(&(module.clone(), symbol.clone())) => Fold::Written { module, symbol },
            _ => Fold::Module(module),
        }
    }

    pub(super) fn fold_key(&mut self, fold: &Fold) -> (Key, Landed) {
        let landed = |module: &ModuleRef| match module {
            ModuleRef::Stdlib(_) => Landed::Stdlib,
            ModuleRef::Missing(_) => Landed::Missing,
            _ => Landed::Site,
        };
        match fold {
            Fold::Module(module) => (self.stubs.module(module, &self.file_keys), landed(module)),
            Fold::Written { module, symbol } | Fold::Class(ClassId::Opaque { module, symbol }) => {
                let parent = self.stubs.module(module, &self.file_keys);
                (self.stubs.type_below(parent, symbol), landed(module))
            }
            Fold::Class(ClassId::Table(class)) => {
                if class.0 == "builtins" {
                    let parent = self.stubs.builtins();
                    return (self.stubs.type_below(parent, class.1), Landed::Builtins);
                }
                let (module, symbol) = self
                    .classes
                    .written(*class)
                    .cloned()
                    .unwrap_or_else(|| (ModuleRef::Stdlib(class.0.to_owned()), class.1.to_owned()));
                let parent = self.stubs.module(&module, &self.file_keys);
                (self.stubs.type_below(parent, &symbol), Landed::Stdlib)
            }
            Fold::Class(ClassId::Corpus { .. }) => unreachable!("a corpus class is never folded"),
        }
    }

    /// A library class as `--explain-dropped` names it.
    fn class_name(&self, id: &ClassId) -> String {
        match id {
            ClassId::Corpus { file, class } => self.files[*file].classes[*class].name.clone(),
            ClassId::Table((module, name)) => format!("{module}.{name}"),
            ClassId::Opaque { module, symbol } => match module {
                ModuleRef::Stdlib(dotted) | ModuleRef::Site(dotted) | ModuleRef::Missing(dotted) => {
                    format!("{dotted}.{symbol}")
                }
                _ => symbol.clone(),
            },
        }
    }

    // ---------------------------------------------------------------- edges ----

    /// One edge from the entity running the site; a `derived` one counted by its inference.
    fn emit(&mut self, ctx: &Ctx<'_>, kind: &'static str, to: Key, inferred: Inferred, access: Option<(bool, bool)>) {
        if !ctx.emit {
            return;
        }
        let provenance = if inferred.is_some() { "derived" } else { "declared" };
        if self.edge_with(kind, &ctx.from, to, provenance, ctx.anchor.clone(), access, None) {
            match kind {
                "invocation" => {
                    self.invokes.insert(ctx.from.clone());
                }
                "access" => {
                    self.accesses.insert(ctx.from.clone());
                }
                _ => {}
            }
            self.count_inference(inferred);
        }
    }
}

#[cfg(test)]
mod tests;
