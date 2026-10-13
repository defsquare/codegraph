//! Pass 1 — what one file WRITES, read off Prism's tree and nothing else:
//! every `class`/`module` body with its lexical parent, every `def` with its
//! parameters, every mixin and `require`, and every SITE inside a body — a
//! constant read, a call and what its receiver is, an instance variable, a
//! `raise`. Names are kept as written; turning them into entities is the
//! resolver's job.

use crate::corpus;
use ruby_prism::{
    AliasMethodNode, AndNode, BlockNode, CallNode, ClassNode, ClassVariableAndWriteNode,
    ClassVariableOperatorWriteNode, ClassVariableOrWriteNode, ClassVariableReadNode, ClassVariableTargetNode,
    ClassVariableWriteNode, ConstantOrWriteNode, ConstantPathNode, ConstantPathOrWriteNode, ConstantPathWriteNode,
    ConstantReadNode, ConstantWriteNode, DefNode, ForNode, ForwardingSuperNode, IfNode, InNode,
    InstanceVariableAndWriteNode, InstanceVariableOperatorWriteNode, InstanceVariableOrWriteNode,
    InstanceVariableReadNode, InstanceVariableTargetNode, InstanceVariableWriteNode, LambdaNode,
    LocalVariableAndWriteNode, LocalVariableOperatorWriteNode, LocalVariableOrWriteNode, LocalVariableTargetNode,
    LocalVariableWriteNode, Location, ModuleNode, Node, OrNode, ParametersNode, RescueModifierNode, RescueNode,
    SingletonClassNode, SuperNode, UnlessNode, UntilNode, Visit, WhenNode, WhileNode,
};
use std::collections::{BTreeMap, HashMap};

/// `[startLine, endLine]`, 1-based and inclusive.
pub type Span = (u32, u32);

pub struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    pub fn new(source: &[u8]) -> Self {
        let mut starts = vec![0];
        starts.extend(
            source
                .iter()
                .enumerate()
                .filter(|(_, b)| **b == b'\n')
                .map(|(at, _)| at + 1),
        );
        LineIndex { starts }
    }

    pub fn line(&self, offset: usize) -> u32 {
        self.starts.partition_point(|&start| start <= offset) as u32
    }

    /// The lines a node covers; its end offset is exclusive.
    pub fn span(&self, location: &Location<'_>) -> Span {
        let start = location.start_offset();
        let last = location.end_offset().saturating_sub(1).max(start);
        (self.line(start), self.line(last))
    }

    fn start_of(&self, line: u32) -> usize {
        self.starts[(line - 1) as usize]
    }
}

/// A constant path as written: `Order`, `Acme::Order`, `::Acme::Order`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ConstPath {
    pub absolute: bool,
    pub segments: Vec<String>,
}

impl ConstPath {
    pub fn simple(name: String) -> Self {
        ConstPath {
            absolute: false,
            segments: vec![name],
        }
    }

    /// The path as the source spells it.
    pub fn written(&self) -> String {
        format!("{}{}", if self.absolute { "::" } else { "" }, self.segments.join("::"))
    }
}

/// A constant named at a site.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConstRef {
    pub path: ConstPath,
    pub span: Span,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeKind {
    /// The file's top level: scope 0, always.
    File,
    Class,
    Module,
    /// A body no key can name (`class << obj`, `class self::Foo`): what it
    /// writes is dropped and counted.
    Opaque,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Superclass {
    None,
    Constant(ConstRef),
    /// `Struct.new(:x)` / `Data.define(:x)`: the language says what that class inherits.
    Core(&'static str, Span),
    /// `< Class.new(Base)`, `< Migration[7.0]`, `< some_method`.
    Computed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MixinKind {
    Include,
    Prepend,
    /// `extend M`, or `include M` inside `class << self`.
    Extend,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mixin {
    pub reference: ConstRef,
    pub kind: MixinKind,
}

/// A written, declaration-site value (METAMODEL §1.6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Lit {
    String(String),
    /// Canonical decimal text.
    Number(String),
    Boolean(bool),
    Null,
    Array(Vec<Lit>),
    /// A constant: a type literal when it names a type, else its source text.
    Constant(ConstPath),
    /// A constant expression not folded — a symbol, a hash, a range: its text.
    Unevaluated(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Param {
    /// Absent for `*`, `**`, `&`, `...` and a destructured position.
    pub name: Option<String>,
    pub span: Span,
    /// The default the source writes, when it is a constant expression.
    pub default: Option<Lit>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MethodDecl {
    pub name: String,
    /// `def self.x`, or a `def` inside `class << self`.
    pub singleton: bool,
    pub span: Span,
    pub signature: String,
    pub parameters: Vec<Param>,
    /// The comment block written directly above.
    pub comment: Option<String>,
    /// 1 + the branches its body writes; blocks count toward the method.
    pub cyclomatic: u32,
    /// Under `module_function`: also answers on the module itself.
    pub module_function: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConstantDecl {
    pub path: ConstPath,
    pub span: Span,
    pub value: Option<Lit>,
    pub comment: Option<String>,
}

/// `attr_reader :x` / `attr_writer :x` / `attr_accessor :x`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttrDecl {
    pub name: String,
    pub span: Span,
    pub reader: bool,
    pub writer: bool,
    /// Written inside `class << self`: an attribute of the class itself.
    pub on_class: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AliasDecl {
    pub new_name: String,
    pub old_name: String,
    pub on_class: bool,
}

/// One `class`/`module` BODY (a type reopened twice in a file is two scopes),
/// or the file's top level.
#[derive(Clone, Debug)]
pub struct Scope {
    pub kind: ScopeKind,
    /// The lexically enclosing scope; absent for the file.
    pub parent: Option<usize>,
    /// The name as written; absent for the file and for an opaque body.
    pub path: Option<ConstPath>,
    pub span: Span,
    pub superclass: Superclass,
    /// No superclass and nothing but class/module declarations inside: lexical
    /// scope, not a declaration (the profile's wrapper rule).
    pub wrapper: bool,
    pub mixins: Vec<Mixin>,
    pub methods: Vec<MethodDecl>,
    pub constants: Vec<ConstantDecl>,
    pub attrs: Vec<AttrDecl>,
    pub aliases: Vec<AliasDecl>,
    /// `Struct.new(:a, :b)` / `Data.define(:a)` members.
    pub members: Vec<(String, Span)>,
    pub comment: Option<String>,
    /// `extend self`: its instance methods answer on the module itself.
    pub extends_self: bool,
    /// It defines methods no `def` writes — `method_missing`, a `define_method`
    /// with a computed name — so an unbound call proves nothing: on its
    /// instances, or on the type itself, whichever side they are defined for.
    pub dynamic_instance: bool,
    pub dynamic_singleton: bool,
    /// The body writes `extend ActiveSupport::Concern`: a `ClassMethods` module
    /// below it extends whatever includes it.
    pub concern: bool,
    /// What including this module also mixes into the includer: what its
    /// `included` hook writes (`base.extend(ClassMethods)`, `included do … end`).
    pub hooks: Vec<Mixin>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequireKind {
    /// `require "feature"`: searched on the load roots.
    Feature,
    /// `require_relative "path"`: from the directory of the file that writes it.
    Relative,
    /// `load "tasks/x.rake"`: a file name, extension and all, on the load roots.
    Load,
    /// `require File.expand_path("../x", __FILE__)` and its kin, folded: a
    /// root-relative path computed from the file's own.
    Path,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Require {
    pub kind: RequireKind,
    pub argument: String,
    pub span: Span,
}

/// The entity a site's edges come FROM: the narrowest one that encloses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    File,
    /// A class or module body: scope index.
    Type(usize),
    /// A method: scope index, index in that scope's `methods`.
    Method(usize, usize),
    /// A constant's initializer: scope index, index in that scope's `constants`.
    Constant(usize, usize),
}

/// What a call is sent to, as far as the source says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Receiver {
    /// `foo(…)`.
    ImplicitSelf,
    /// `self.foo(…)`.
    ExplicitSelf,
    /// `self.class.foo(…)`.
    SelfClass,
    /// `Foo.bar(…)`.
    Constant(ConstPath),
    /// `Foo.new(…).bar`: an instance of `Foo`, by the definition of `new`.
    New(ConstPath),
    /// `new(…).bar` where `self` is a class: an instance of that class.
    NewSelf,
    /// `x.bar` where every assignment to the local `x` in this body is `Foo.new(…)`.
    TypedLocal(ConstPath),
    /// `@x.bar`: typed, or not, by what the type assigns to `@x`.
    Variable(String),
    /// `"text".upcase`, `[1, 2].map`: a literal of a core class.
    Literal(&'static str),
    /// Anything else: a parameter, a call's result, a block argument.
    Untyped,
    /// A local whose assignments are not all read yet (resolved when its body ends).
    Local(String),
}

/// What a `@x = …` assigns, for typing `@x`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Assigned {
    New(ConstPath),
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum What {
    /// A constant read.
    Constant(ConstPath),
    /// The `Admin` of `class Admin::Users`: read to open the type below it.
    Qualifier(ConstPath),
    Call {
        receiver: Receiver,
        name: String,
    },
    /// `super` / `super(…)`.
    Super,
    /// `@x` or `@@x`.
    Variable {
        name: String,
        read: bool,
        write: bool,
        assigned: Option<Assigned>,
    },
    /// `raise Foo` (the constant), or `raise "text"` (none: a RuntimeError).
    Raise(Option<ConstPath>),
    /// `method(:foo)`: the method as a value.
    MethodRef {
        receiver: Receiver,
        name: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Site {
    pub owner: Owner,
    /// The lexical scope: where constants are looked up, and whose `self` this is.
    pub scope: usize,
    /// `self` is the type itself (a class body, a singleton method), not an instance.
    pub on_class: bool,
    pub span: Span,
    pub what: What,
}

/// Something written that became neither a declaration nor a site: why, where, what.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dropped {
    pub reason: &'static str,
    pub line: u32,
    pub what: String,
}

pub struct FileDecls {
    pub scopes: Vec<Scope>,
    pub requires: Vec<Require>,
    pub sites: Vec<Site>,
    /// What the walk could not model, in the order it met it.
    pub drops: Vec<Dropped>,
    /// Syntax errors Prism recovered from.
    pub errors: usize,
    /// Names that were not valid UTF-8 and were written with U+FFFD.
    pub lossy_names: u64,
    /// Per line (0-based): neither blank, nor comment-only, nor `__END__` data.
    pub code_lines: Vec<bool>,
}

impl FileDecls {
    /// Source lines of code in a span (METAMODEL §3.8).
    pub fn sloc(&self, span: Span) -> u32 {
        let from = (span.0.max(1) - 1) as usize;
        let to = (span.1 as usize).min(self.code_lines.len());
        self.code_lines
            .get(from..to)
            .map(|lines| lines.iter().filter(|code| **code).count() as u32)
            .unwrap_or(0)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Context {
    /// Directly in a file, a class, a module or a `class << self`.
    Body,
    Def,
    Block,
}

/// The locals of one body (`def`, class body, file): blocks share them.
#[derive(Default)]
struct Frame {
    /// A local → the one class every assignment to it instantiates, if there is one.
    locals: HashMap<String, Option<ConstPath>>,
    /// Sites whose receiver is a local, to be typed when the body ends.
    pending: Vec<(usize, String)>,
}

struct Walker<'a> {
    lines: &'a LineIndex,
    /// The comment block ending on a line → its text.
    comments: HashMap<u32, String>,
    scopes: Vec<Scope>,
    requires: Vec<Require>,
    sites: Vec<Site>,
    drops: Vec<Dropped>,
    scope: usize,
    owner: Owner,
    on_class: bool,
    singleton_depth: u32,
    /// Inside a body whose `self` no key names: calls and variables are not recorded.
    unkeyed: u32,
    /// `module_function` with no argument was written in this body.
    module_function: bool,
    context: Vec<Context>,
    frames: Vec<Frame>,
    /// Branches counted so far, one counter per method being walked.
    branches: Vec<u32>,
    lossy_names: u64,
    /// Inside `def self.included(base)`: the name `base` goes by.
    hook_param: Option<String>,
    /// Inside a concern's `included do … end`: the depth of the block's own statements.
    hook_block: Option<usize>,
}

fn new_scope(kind: ScopeKind, parent: Option<usize>, path: Option<ConstPath>, span: Span) -> Scope {
    Scope {
        kind,
        parent,
        path,
        span,
        superclass: Superclass::None,
        wrapper: false,
        mixins: Vec::new(),
        methods: Vec::new(),
        constants: Vec::new(),
        attrs: Vec::new(),
        aliases: Vec::new(),
        members: Vec::new(),
        comment: None,
        extends_self: false,
        dynamic_instance: false,
        dynamic_singleton: false,
        concern: false,
        hooks: Vec::new(),
    }
}

/// Comment lines that say nothing about the code below them.
fn is_directive(text: &str) -> bool {
    let body = text.trim_start_matches('#').trim_start();
    text.starts_with("#!")
        || [
            "frozen_string_literal:",
            "encoding:",
            "coding:",
            "warn_indent:",
            "shareable_constant_value:",
            "typed:",
        ]
        .iter()
        .any(|magic| body.starts_with(magic))
        || body.starts_with("rubocop:")
        || body.starts_with("-*-")
}

/// Which lines are code, and the comment block that ends on each line.
fn read_comments(
    source: &[u8],
    lines: &LineIndex,
    result: &ruby_prism::ParseResult<'_>,
) -> (Vec<bool>, HashMap<u32, String>) {
    let total = corpus::line_count(source) as usize;
    let mut code = vec![true; total];
    let mut starts = lines.starts.clone();
    starts.push(source.len());
    for (line, flag) in code.iter_mut().enumerate() {
        let (from, to) = (starts[line].min(source.len()), starts[line + 1].min(source.len()));
        if source[from..to].iter().all(u8::is_ascii_whitespace) {
            *flag = false;
        }
    }
    // Lines whose only content is a comment, with that comment's text.
    let mut only: BTreeMap<u32, String> = BTreeMap::new();
    for comment in result.comments() {
        let location = comment.location();
        let (first, last) = lines.span(&location);
        if comment.type_() == ruby_prism::CommentType::EmbDocComment {
            // `=begin … =end`: every line of it is a comment line.
            for line in first..=last {
                if let Some(flag) = code.get_mut((line - 1) as usize) {
                    *flag = false;
                }
            }
            continue;
        }
        let line_start = lines.start_of(first);
        if source[line_start..location.start_offset()]
            .iter()
            .all(u8::is_ascii_whitespace)
        {
            if let Some(flag) = code.get_mut((first - 1) as usize) {
                *flag = false;
            }
            only.insert(
                first,
                String::from_utf8_lossy(location.as_slice()).trim_end().to_owned(),
            );
        }
    }
    // What follows `__END__` is data, not code.
    if let Some(data) = result.data_loc() {
        for line in lines.line(data.start_offset())..=(total as u32) {
            if let Some(flag) = code.get_mut((line - 1) as usize) {
                *flag = false;
            }
        }
    }

    // Consecutive comment lines form a block; directives are transparent.
    let mut blocks: HashMap<u32, String> = HashMap::new();
    let mut current: Vec<String> = Vec::new();
    let mut previous = 0u32;
    let flush = |current: &mut Vec<String>, last: u32, blocks: &mut HashMap<u32, String>| {
        while current.first().is_some_and(|line| line.is_empty()) {
            current.remove(0);
        }
        while current.last().is_some_and(|line| line.is_empty()) {
            current.pop();
        }
        if !current.is_empty() {
            blocks.insert(last, current.join("\n"));
        }
        current.clear();
    };
    for (line, text) in &only {
        if previous != 0 && *line != previous + 1 {
            flush(&mut current, previous, &mut blocks);
        }
        if !is_directive(text) {
            let body = text.trim_start_matches('#');
            current.push(body.strip_prefix(' ').unwrap_or(body).to_owned());
        }
        previous = *line;
    }
    if previous != 0 {
        flush(&mut current, previous, &mut blocks);
    }
    (code, blocks)
}

/// Parses one file and reads off what it declares.
pub fn declarations(source: &[u8]) -> FileDecls {
    let result = ruby_prism::parse(source);
    let lines = LineIndex::new(source);
    let (code_lines, comments) = read_comments(source, &lines, &result);
    let file = new_scope(ScopeKind::File, None, None, (1, corpus::line_count(source)));
    let mut walker = Walker {
        lines: &lines,
        comments,
        scopes: vec![file],
        requires: Vec::new(),
        sites: Vec::new(),
        drops: Vec::new(),
        scope: 0,
        owner: Owner::File,
        on_class: false,
        singleton_depth: 0,
        unkeyed: 0,
        module_function: false,
        context: vec![Context::Body],
        frames: vec![Frame::default()],
        branches: Vec::new(),
        lossy_names: 0,
        hook_param: None,
        hook_block: None,
    };
    walker.visit(&result.node());
    walker.close_frame();
    FileDecls {
        scopes: walker.scopes,
        requires: walker.requires,
        sites: walker.sites,
        drops: walker.drops,
        errors: result.errors().count(),
        lossy_names: walker.lossy_names,
        code_lines,
    }
}

/// An empty body is a declaration; so is one with a `rescue`. A wrapper has
/// statements, and every one of them declares a class or a module.
fn body_is_wrapper(body: Option<Node<'_>>) -> bool {
    let Some(statements) = body.and_then(|body| body.as_statements_node()) else {
        return false;
    };
    let mut declarations = 0;
    for statement in statements.body().iter() {
        // `Point = Struct.new(:x)` declares a type as `class Point` does.
        let declares_a_type = statement.as_class_node().is_some()
            || statement.as_module_node().is_some()
            || statement
                .as_constant_write_node()
                .is_some_and(|write| synthetic_of(&write.value()).is_some());
        if !declares_a_type {
            return false;
        }
        declarations += 1;
    }
    declarations > 0
}

/// `Struct.new(…)`, `Data.define(…)`, `Class.new(…)`, `Module.new` — on the
/// core class itself, written `Struct` or `::Struct`.
fn synthetic_of(value: &Node<'_>) -> Option<Synthetic> {
    let call = value.as_call_node()?;
    let receiver = call.receiver()?;
    let class = match (receiver.as_constant_read_node(), receiver.as_constant_path_node()) {
        (Some(read), _) => read.name().as_slice().to_vec(),
        (_, Some(path)) if path.parent().is_none() => path.name()?.as_slice().to_vec(),
        _ => return None,
    };
    match (class.as_slice(), call.name().as_slice()) {
        (b"Struct", b"new") => Some(Synthetic::Struct),
        (b"Data", b"define") => Some(Synthetic::Data),
        (b"Class", b"new") => Some(Synthetic::Class),
        (b"Module", b"new") => Some(Synthetic::Module),
        _ => None,
    }
}

fn squeeze(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `+`, `==`, `[]`, `!`: a method whose name is not an identifier.
pub fn is_operator(name: &str) -> bool {
    !name
        .chars()
        .next()
        .is_some_and(|first| first.is_alphabetic() || first == '_')
}

fn is_const_path(node: &Node<'_>) -> bool {
    node.as_constant_read_node().is_some() || node.as_constant_path_node().is_some()
}

/// What `X = Struct.new(…)` and its kin make of the constant.
enum Synthetic {
    Struct,
    Data,
    Class,
    Module,
}

impl Walker<'_> {
    /// Counts what no key or site can carry, with where it is written.
    fn drop(&mut self, reason: &'static str, line: u32, what: &str) {
        self.drops.push(Dropped {
            reason,
            line,
            what: what.to_owned(),
        });
    }

    /// Drops a call: named by the method it sends, at the line that name is written on.
    fn drop_call(&mut self, reason: &'static str, node: &CallNode<'_>) {
        let location = node.message_loc().unwrap_or_else(|| node.location());
        let line = self.lines.line(location.start_offset());
        let what = String::from_utf8_lossy(node.name().as_slice()).into_owned();
        self.drop(reason, line, &what);
    }

    fn text(&mut self, bytes: &[u8]) -> String {
        match std::str::from_utf8(bytes) {
            Ok(text) => text.to_owned(),
            Err(_) => {
                self.lossy_names += 1;
                String::from_utf8_lossy(bytes).into_owned()
            }
        }
    }

    fn source_of(&self, location: &Location<'_>) -> String {
        squeeze(&String::from_utf8_lossy(location.as_slice()))
    }

    /// The comment block written directly above a line.
    fn doc_above(&self, line: u32) -> Option<String> {
        line.checked_sub(1).and_then(|above| self.comments.get(&above).cloned())
    }

    fn keyed(&self) -> bool {
        self.unkeyed == 0
    }

    fn site(&mut self, span: Span, what: What) -> usize {
        self.sites.push(Site {
            owner: self.owner,
            scope: self.scope,
            on_class: self.on_class,
            span,
            what,
        });
        self.sites.len() - 1
    }

    fn branch(&mut self) {
        if let Some(count) = self.branches.last_mut() {
            *count += 1;
        }
    }

    fn const_path(&mut self, node: &Node<'_>) -> Option<ConstPath> {
        if let Some(read) = node.as_constant_read_node() {
            return Some(ConstPath::simple(self.text(read.name().as_slice())));
        }
        self.const_path_node(&node.as_constant_path_node()?)
    }

    fn const_path_node(&mut self, path: &ConstantPathNode<'_>) -> Option<ConstPath> {
        let name = self.text(path.name()?.as_slice());
        match path.parent() {
            None => Some(ConstPath {
                absolute: true,
                segments: vec![name],
            }),
            Some(parent) => {
                // `self::Foo`, `config::Foo`: the parent is a value, not a constant.
                let mut base = self.const_path(&parent)?;
                base.segments.push(name);
                Some(base)
            }
        }
    }

    /// `Foo.new(…)`: the class it instantiates.
    fn instantiated(&mut self, node: &Node<'_>) -> Option<ConstPath> {
        let call = node.as_call_node()?;
        if call.name().as_slice() != b"new" {
            return None;
        }
        self.const_path(&call.receiver()?)
    }

    /// A symbol or string literal naming something: `:total`, `"total"`.
    fn name_literal(&mut self, node: &Node<'_>) -> Option<String> {
        let bytes = match (node.as_symbol_node(), node.as_string_node()) {
            (Some(symbol), _) => symbol.unescaped().to_vec(),
            (_, Some(string)) => string.unescaped().to_vec(),
            _ => return None,
        };
        String::from_utf8(bytes).ok().filter(|name| !name.is_empty())
    }

    /// A written value, when it is a constant expression.
    fn literal(&mut self, node: &Node<'_>) -> Option<Lit> {
        if let Some(string) = node.as_string_node() {
            return String::from_utf8(string.unescaped().to_vec()).ok().map(Lit::String);
        }
        if node.as_integer_node().is_some() || node.as_float_node().is_some() {
            let text: String = self.source_of(&node.location()).replace('_', "");
            return Some(if is_decimal(&text) {
                Lit::Number(text)
            } else {
                Lit::Unevaluated(text)
            });
        }
        if node.as_true_node().is_some() {
            return Some(Lit::Boolean(true));
        }
        if node.as_false_node().is_some() {
            return Some(Lit::Boolean(false));
        }
        if node.as_nil_node().is_some() {
            return Some(Lit::Null);
        }
        if let Some(array) = node.as_array_node() {
            let mut items = Vec::new();
            for element in array.elements().iter() {
                items.push(self.literal(&element)?);
            }
            return Some(Lit::Array(items));
        }
        if is_const_path(node) {
            return self.const_path(node).map(Lit::Constant);
        }
        if let Some(call) = node.as_call_node() {
            // `"x".freeze`, `%w[a b].freeze`: the same value, frozen.
            if call.name().as_slice() == b"freeze" && call.arguments().is_none() {
                return self.literal(&call.receiver()?);
            }
            return None;
        }
        let constant_shaped = node.as_symbol_node().is_some()
            || node.as_regular_expression_node().is_some()
            || node.as_range_node().is_some_and(|range| {
                range.left().is_none_or(|left| self.literal(&left).is_some())
                    && range.right().is_none_or(|right| self.literal(&right).is_some())
            })
            || node.as_hash_node().is_some_and(|hash| {
                hash.elements().iter().all(|element| {
                    element.as_assoc_node().is_some_and(|pair| {
                        self.literal(&pair.key()).is_some() && self.literal(&pair.value()).is_some()
                    })
                })
            });
        constant_shaped.then(|| Lit::Unevaluated(self.source_of(&node.location())))
    }

    fn open_frame(&mut self, parameters: &[Param]) {
        let mut frame = Frame::default();
        // A parameter can be passed anything: it types nothing.
        for parameter in parameters {
            if let Some(name) = &parameter.name {
                frame.locals.insert(name.clone(), None);
            }
        }
        self.frames.push(frame);
    }

    /// Types the receivers that were locals, now that every assignment is read.
    fn close_frame(&mut self) {
        let Some(frame) = self.frames.pop() else { return };
        for (site, name) in frame.pending {
            let typed = frame.locals.get(&name).cloned().flatten();
            let receiver = typed.map(Receiver::TypedLocal).unwrap_or(Receiver::Untyped);
            match &mut self.sites[site].what {
                What::Call { receiver: slot, .. } | What::MethodRef { receiver: slot, .. } => *slot = receiver,
                _ => {}
            }
        }
    }

    fn assign_local(&mut self, name: String, value: Option<ConstPath>) {
        let Some(frame) = self.frames.last_mut() else { return };
        match frame.locals.get(&name) {
            None => {
                frame.locals.insert(name, value);
            }
            Some(known) if *known == value && value.is_some() => {}
            Some(_) => {
                frame.locals.insert(name, None);
            }
        }
    }

    /// Enters a class or module body (or an opaque one).
    fn enter<'pr>(&mut self, scope: Scope, body: Option<Node<'pr>>)
    where
        Self: Visit<'pr>,
    {
        let index = self.scopes.len();
        self.scopes.push(scope);
        self.enter_at(index, body);
    }

    /// Enters the body of a scope already recorded at `index`.
    fn enter_at<'pr>(&mut self, index: usize, body: Option<Node<'pr>>)
    where
        Self: Visit<'pr>,
    {
        let opaque = self.scopes[index].kind == ScopeKind::Opaque;
        let outer = (
            self.scope,
            self.owner,
            self.on_class,
            self.singleton_depth,
            self.module_function,
        );
        self.scope = index;
        self.singleton_depth = 0;
        self.module_function = false;
        if opaque {
            self.unkeyed += 1;
        } else {
            self.owner = Owner::Type(index);
            self.on_class = true;
        }
        self.context.push(Context::Body);
        self.frames.push(Frame::default());
        if let Some(body) = body {
            self.visit(&body);
        }
        self.close_frame();
        self.context.pop();
        if opaque {
            self.unkeyed -= 1;
        }
        (
            self.scope,
            self.owner,
            self.on_class,
            self.singleton_depth,
            self.module_function,
        ) = outer;
    }

    /// The scope a `class`/`module` keyword opens — opaque when no key can name it.
    fn type_scope(&mut self, kind: ScopeKind, name: &Node<'_>, span: Span) -> Scope {
        let path = self.const_path(name);
        // A type written inside a singleton class or an opaque body is a
        // constant of something no key names.
        let nameable = self.singleton_depth == 0 && self.scopes[self.scope].kind != ScopeKind::Opaque;
        match path {
            Some(path) if nameable => {
                let mut scope = new_scope(kind, Some(self.scope), Some(path), span);
                scope.comment = self.doc_above(span.0);
                scope
            }
            path => {
                let reason = if path.is_none() {
                    "computed-type-name"
                } else {
                    "type-in-singleton"
                };
                let written = self.source_of(&name.location());
                self.drop(reason, span.0, &written);
                new_scope(ScopeKind::Opaque, Some(self.scope), None, span)
            }
        }
    }

    /// `class Admin::Users` reads `Admin`: a constant read like any other,
    /// made by the type being declared, in the scope it is written in.
    fn qualifier(&mut self, index: usize, name: &Node<'_>) {
        let scope = &self.scopes[index];
        let Some(path) = scope.path.as_ref().filter(|path| path.segments.len() > 1) else {
            return;
        };
        if scope.kind == ScopeKind::Opaque {
            return;
        }
        let qualifier = ConstPath {
            absolute: path.absolute,
            segments: path.segments[..path.segments.len() - 1].to_vec(),
        };
        let span = self.lines.span(&name.location());
        let outer = std::mem::replace(&mut self.owner, Owner::Type(index));
        self.site(span, What::Qualifier(qualifier));
        self.owner = outer;
    }

    /// The members `Struct.new(:a, :b)` / `Data.define(:a)` name.
    fn members(&mut self, call: &CallNode<'_>) -> Vec<(String, Span)> {
        let mut members = Vec::new();
        for argument in call
            .arguments()
            .iter()
            .flat_map(|arguments| arguments.arguments().iter())
        {
            if let Some(symbol) = argument.as_symbol_node()
                && let Ok(name) = String::from_utf8(symbol.unescaped().to_vec())
            {
                members.push((name, self.lines.span(&symbol.location())));
            }
        }
        members
    }

    /// `X = Struct.new(:a) do … end`: a class named `X`, its block the body.
    fn synthetic_type<'pr>(&mut self, name: String, span: Span, kind: Synthetic, value: &Node<'pr>)
    where
        Self: Visit<'pr>,
    {
        let call = value.as_call_node().expect("a synthetic type is a call");
        let scope_kind = if matches!(kind, Synthetic::Module) {
            ScopeKind::Module
        } else {
            ScopeKind::Class
        };
        let mut scope = new_scope(scope_kind, Some(self.scope), Some(ConstPath::simple(name)), span);
        scope.comment = self.doc_above(span.0);
        let call_span = self.lines.span(&call.location());
        match kind {
            Synthetic::Struct => {
                scope.superclass = Superclass::Core("Struct", call_span);
                scope.members = self.members(&call);
            }
            Synthetic::Data => {
                scope.superclass = Superclass::Core("Data", call_span);
                scope.members = self.members(&call);
            }
            Synthetic::Class => {
                let first = call
                    .arguments()
                    .and_then(|arguments| arguments.arguments().iter().next());
                scope.superclass = match first {
                    None => Superclass::None,
                    Some(argument) => match self.const_path(&argument) {
                        Some(path) => Superclass::Constant(ConstRef {
                            path,
                            span: self.lines.span(&argument.location()),
                        }),
                        None => Superclass::Computed,
                    },
                };
            }
            Synthetic::Module => {}
        }
        // Arguments that are not the superclass are evaluated where the constant is written.
        for argument in call
            .arguments()
            .iter()
            .flat_map(|arguments| arguments.arguments().iter())
        {
            if !is_const_path(&argument) {
                self.visit(&argument);
            }
        }
        let body = call
            .block()
            .and_then(|block| block.as_block_node())
            .and_then(|block| block.body());
        self.enter(scope, body);
    }

    fn constant_decl<'pr>(&mut self, path: ConstPath, span: Span, value: &Node<'pr>)
    where
        Self: Visit<'pr>,
    {
        if self.scopes[self.scope].kind == ScopeKind::Opaque {
            self.visit(value);
            return;
        }
        let literal = self.literal(value);
        let comment = self.doc_above(span.0);
        let index = self.scopes[self.scope].constants.len();
        self.scopes[self.scope].constants.push(ConstantDecl {
            path,
            span,
            value: literal,
            comment,
        });
        // An initializer's edges come from the constant: the narrowest owner.
        let outer = self.owner;
        self.owner = Owner::Constant(self.scope, index);
        self.visit(value);
        self.owner = outer;
    }

    /// `require "x"`, `require_relative "x"`, `load "x.rb"`, `autoload :X, "x"`.
    fn require(&mut self, node: &CallNode<'_>, name: &[u8]) {
        let Some(arguments) = node.arguments() else { return };
        let list: Vec<Node<'_>> = arguments.arguments().iter().collect();
        let argument = match (name, list.as_slice()) {
            // `autoload :Const, "feature"`: the feature is the second argument.
            (b"autoload", [_, feature]) => feature,
            (b"autoload", _) => return,
            (_, [only]) => only,
            // `load "x.rb", true`.
            (b"load", [first, _]) => first,
            _ => return self.drop_call("computed-require", node),
        };
        let span = self.lines.span(&node.location());
        if let Some(literal) = argument.as_string_node() {
            match String::from_utf8(literal.unescaped().to_vec())
                .ok()
                .filter(|text| !text.is_empty())
            {
                Some(argument) => {
                    let kind = match name {
                        b"require_relative" => RequireKind::Relative,
                        b"load" => RequireKind::Load,
                        _ => RequireKind::Feature,
                    };
                    self.requires.push(Require { kind, argument, span });
                }
                None => self.drop_call("computed-require", node),
            }
            return;
        }
        // The Ruby 1.8 spellings of `require_relative`.
        match self.path_from_file(argument) {
            Some(argument) => self.requires.push(Require {
                kind: RequireKind::Path,
                argument,
                span,
            }),
            None => self.drop_call("computed-require", node),
        }
    }

    /// A path built from the file's own, as `<dir>/…` relative to the file's
    /// directory: `File.expand_path("../x", __FILE__)`, `File.expand_path("x", __dir__)`,
    /// `File.join(File.dirname(__FILE__), "x")`, `File.dirname(__FILE__) + "/x"`, `"#{__dir__}/x"`.
    fn path_from_file(&mut self, node: &Node<'_>) -> Option<String> {
        let text = |node: &Node<'_>| -> Option<String> {
            node.as_string_node()
                .and_then(|string| String::from_utf8(string.unescaped().to_vec()).ok())
        };
        // The file's directory: `__dir__` or `File.dirname(__FILE__)`.
        fn is_dir(node: &Node<'_>) -> bool {
            let Some(call) = node.as_call_node() else { return false };
            match (call.name().as_slice(), call.receiver()) {
                (b"__dir__", None) => true,
                (b"dirname", Some(receiver)) => {
                    receiver
                        .as_constant_read_node()
                        .is_some_and(|c| c.name().as_slice() == b"File")
                        && call
                            .arguments()
                            .and_then(|arguments| arguments.arguments().iter().next())
                            .is_some_and(|argument| argument.as_source_file_node().is_some())
                }
                _ => false,
            }
        }
        if let Some(interpolated) = node.as_interpolated_string_node() {
            // "#{__dir__}/x"
            let parts: Vec<Node<'_>> = interpolated.parts().iter().collect();
            let [first, rest] = parts.as_slice() else { return None };
            let embedded = first
                .as_embedded_statements_node()?
                .statements()?
                .body()
                .iter()
                .next()?;
            return is_dir(&embedded)
                .then(|| text(rest))
                .flatten()
                .map(|rest| format!(".{rest}"));
        }
        let call = node.as_call_node()?;
        let arguments: Vec<Node<'_>> = call
            .arguments()
            .map(|a| a.arguments().iter().collect())
            .unwrap_or_default();
        let on_file = call.receiver().is_some_and(|r| {
            r.as_constant_read_node()
                .is_some_and(|c| c.name().as_slice() == b"File")
        });
        match (call.name().as_slice(), arguments.as_slice()) {
            // File.expand_path("../x", __FILE__): relative to the FILE, so one `..` is its directory.
            (b"expand_path", [path, base]) if on_file && base.as_source_file_node().is_some() => {
                text(path).map(|path| format!("./__file__/{path}"))
            }
            (b"expand_path", [path, base]) if on_file && is_dir(base) => text(path).map(|path| format!("./{path}")),
            (b"join", [base, rest @ ..]) if on_file && is_dir(base) && !rest.is_empty() => {
                let parts: Option<Vec<String>> = rest.iter().map(&text).collect();
                parts.map(|parts| format!("./{}", parts.join("/")))
            }
            (b"+", [path]) if call.receiver().is_some_and(|receiver| is_dir(&receiver)) => {
                text(path).map(|path| format!(".{path}"))
            }
            _ => None,
        }
    }

    /// `include M` / `extend M` / `prepend M` written directly in a type's body.
    fn mixin(&mut self, node: &CallNode<'_>, name: &[u8]) -> bool {
        // Written in a concern's `included do … end`, it is what INCLUDERS mix in.
        let hooked = self.hook_block == Some(self.context.len());
        // Inside any other block or a method it is not a declaration of this
        // type: the profile's stated blind spot.
        if self.context.last() != Some(&Context::Body) && !hooked {
            return false;
        }
        let Some(arguments) = node.arguments() else {
            return false;
        };
        if hooked {
            let kind = match name {
                b"extend" => MixinKind::Extend,
                b"prepend" => MixinKind::Prepend,
                _ => MixinKind::Include,
            };
            for argument in arguments.arguments().iter() {
                self.hook(kind, &argument);
            }
            // Not a mixin of THIS module: the call and the constant it names
            // are read like any other.
            return false;
        }
        let kind = match (name, self.singleton_depth > 0) {
            // `extend` inside `class << self` extends the singleton's singleton.
            (b"extend", true) => return false,
            (b"extend", false) | (b"include", true) => MixinKind::Extend,
            (b"prepend", _) => MixinKind::Prepend,
            _ => MixinKind::Include,
        };
        match self.scopes[self.scope].kind {
            ScopeKind::Class | ScopeKind::Module => {}
            ScopeKind::File => {
                self.drop_call("toplevel-mixin", node);
                return false;
            }
            ScopeKind::Opaque => return false,
        }
        for argument in arguments.arguments().iter() {
            if argument.as_self_node().is_some() {
                // `extend self`: the module's own methods answer on it.
                if kind == MixinKind::Extend {
                    self.scopes[self.scope].extends_self = true;
                }
                continue;
            }
            match self.const_path(&argument) {
                Some(path) => {
                    let span = self.lines.span(&argument.location());
                    if kind == MixinKind::Extend && path.segments == ["ActiveSupport", "Concern"] {
                        self.scopes[self.scope].concern = true;
                    }
                    self.scopes[self.scope].mixins.push(Mixin {
                        reference: ConstRef { path, span },
                        kind,
                    });
                }
                None => self.drop_call("computed-mixin", node),
            }
        }
        true
    }

    /// Records what including the module being read also mixes into the includer.
    fn hook(&mut self, kind: MixinKind, argument: &Node<'_>) {
        if let Some(path) = self.const_path(argument) {
            let span = self.lines.span(&argument.location());
            self.scopes[self.scope].hooks.push(Mixin {
                reference: ConstRef { path, span },
                kind,
            });
        }
    }

    /// `base.extend(ClassMethods)`, `base.send(:include, Helpers)` in `def self.included(base)`.
    fn hook_call(&mut self, node: &CallNode<'_>, name: &[u8]) {
        let Some(base) = &self.hook_param else { return };
        let on_base = node
            .receiver()
            .and_then(|receiver| receiver.as_local_variable_read_node())
            .is_some_and(|local| local.name().as_slice() == base.as_bytes());
        if !on_base {
            return;
        }
        let mut arguments: Vec<Node<'_>> = node
            .arguments()
            .iter()
            .flat_map(|arguments| arguments.arguments().iter())
            .collect();
        let verb = match name {
            b"send" | b"__send__" | b"public_send" if !arguments.is_empty() => {
                self.name_literal(&arguments.remove(0)).unwrap_or_default()
            }
            _ => self.text(name),
        };
        let kind = match verb.as_str() {
            "extend" => MixinKind::Extend,
            "include" => MixinKind::Include,
            "prepend" => MixinKind::Prepend,
            _ => return,
        };
        for argument in &arguments {
            self.hook(kind, argument);
        }
    }

    /// `attr_reader :a, :b` and its kin, written in a type's body.
    fn attributes(&mut self, node: &CallNode<'_>, name: &[u8]) -> bool {
        if self.context.last() != Some(&Context::Body)
            || !matches!(self.scopes[self.scope].kind, ScopeKind::Class | ScopeKind::Module)
        {
            return false;
        }
        let (reader, writer) = match name {
            b"attr_reader" | b"attr" => (true, false),
            b"attr_writer" => (false, true),
            _ => (true, true),
        };
        let on_class = self.singleton_depth > 0;
        for argument in node
            .arguments()
            .iter()
            .flat_map(|arguments| arguments.arguments().iter())
        {
            match self.name_literal(&argument) {
                Some(name) => {
                    let span = self.lines.span(&argument.location());
                    self.scopes[self.scope].attrs.push(AttrDecl {
                        name,
                        span,
                        reader,
                        writer,
                        on_class,
                    });
                }
                // `attr :x, true` (Ruby 1.8) and computed names.
                None => self.drop_call("computed-attribute", node),
            }
        }
        true
    }

    fn alias(&mut self, line: u32, new_name: Option<String>, old_name: Option<String>) {
        if !matches!(self.scopes[self.scope].kind, ScopeKind::Class | ScopeKind::Module) || !self.keyed() {
            return;
        }
        match (new_name, old_name) {
            (Some(new_name), Some(old_name)) => {
                let on_class = self.singleton_depth > 0;
                self.scopes[self.scope].aliases.push(AliasDecl {
                    new_name,
                    old_name,
                    on_class,
                });
            }
            _ => self.drop("computed-alias", line, "alias"),
        }
    }

    /// What a call is sent to.
    fn receiver(&mut self, node: &CallNode<'_>) -> Receiver {
        let Some(receiver) = node.receiver() else {
            return Receiver::ImplicitSelf;
        };
        if receiver.as_self_node().is_some() {
            return Receiver::ExplicitSelf;
        }
        if let Some(path) = self.const_path(&receiver) {
            return Receiver::Constant(path);
        }
        if let Some(path) = self.instantiated(&receiver) {
            return Receiver::New(path);
        }
        if let Some(call) = receiver.as_call_node() {
            let on_self = call.receiver().is_some_and(|inner| inner.as_self_node().is_some());
            // `new(…).foo` / `self.new(…).foo`
            if call.name().as_slice() == b"new" && (call.receiver().is_none() || on_self) {
                return Receiver::NewSelf;
            }
            // `self.class.foo`
            if on_self && call.name().as_slice() == b"class" && call.arguments().is_none() {
                return Receiver::SelfClass;
            }
            return Receiver::Untyped;
        }
        if let Some(local) = receiver.as_local_variable_read_node() {
            return Receiver::Local(self.text(local.name().as_slice()));
        }
        if let Some(variable) = receiver.as_instance_variable_read_node() {
            return Receiver::Variable(self.text(variable.name().as_slice()));
        }
        if let Some(variable) = receiver.as_class_variable_read_node() {
            return Receiver::Variable(self.text(variable.name().as_slice()));
        }
        let literal = if receiver.as_string_node().is_some()
            || receiver.as_interpolated_string_node().is_some()
            || receiver.as_x_string_node().is_some()
        {
            "String"
        } else if receiver.as_symbol_node().is_some() || receiver.as_interpolated_symbol_node().is_some() {
            "Symbol"
        } else if receiver.as_integer_node().is_some() {
            "Integer"
        } else if receiver.as_float_node().is_some() {
            "Float"
        } else if receiver.as_array_node().is_some() {
            "Array"
        } else if receiver.as_hash_node().is_some() {
            "Hash"
        } else if receiver.as_range_node().is_some() {
            "Range"
        } else if receiver.as_regular_expression_node().is_some() {
            "Regexp"
        } else if receiver.as_true_node().is_some() {
            "TrueClass"
        } else if receiver.as_false_node().is_some() {
            "FalseClass"
        } else if receiver.as_nil_node().is_some() {
            "NilClass"
        } else if receiver.as_lambda_node().is_some() {
            "Proc"
        } else {
            return Receiver::Untyped;
        };
        Receiver::Literal(literal)
    }

    /// Records a call (or a method taken as a value), deferring a local receiver.
    fn call_site(&mut self, span: Span, receiver: Receiver, name: String, reference: bool) {
        if !self.keyed() {
            return self.drop("call-in-unkeyed-body", span.0, &name);
        }
        let pending = match &receiver {
            Receiver::Local(local) => Some(local.clone()),
            _ => None,
        };
        let what = if reference {
            What::MethodRef { receiver, name }
        } else {
            What::Call { receiver, name }
        };
        let site = self.site(span, what);
        if let (Some(local), Some(frame)) = (pending, self.frames.last_mut()) {
            frame.pending.push((site, local));
        }
    }

    fn variable(&mut self, name: &[u8], location: &Location<'_>, read: bool, write: bool, assigned: Option<Assigned>) {
        if !self.keyed() {
            return;
        }
        let name = self.text(name);
        let span = self.lines.span(location);
        self.site(
            span,
            What::Variable {
                name,
                read,
                write,
                assigned,
            },
        );
    }

    fn assigned(&mut self, value: &Node<'_>) -> Option<Assigned> {
        Some(self.instantiated(value).map(Assigned::New).unwrap_or(Assigned::Other))
    }

    /// The parameters as entities, and the method as it would be called:
    /// `total(currency, [precision], *rest, tax:, [rounding:], **opts, &blk)`.
    fn parameters(&mut self, name: &str, singleton: bool, node: Option<ParametersNode<'_>>) -> (Vec<Param>, String) {
        let mut parameters = Vec::new();
        let mut written: Vec<String> = Vec::new();
        if let Some(node) = node {
            for parameter in node.requireds().iter() {
                self.positional(&parameter, &mut parameters, &mut written);
            }
            for parameter in node.optionals().iter() {
                match parameter.as_optional_parameter_node() {
                    Some(optional) => {
                        let name = self.text(optional.name().as_slice());
                        written.push(format!("[{name}]"));
                        let default = self.literal(&optional.value());
                        parameters.push(Param {
                            name: Some(name),
                            span: self.lines.span(&optional.location()),
                            default,
                        });
                    }
                    None => self.unnamed(&parameter, &mut parameters, &mut written),
                }
            }
            if let Some(rest) = node.rest() {
                match rest.as_rest_parameter_node() {
                    Some(splat) => {
                        let name = splat.name().map(|name| self.text(name.as_slice()));
                        written.push(format!("*{}", name.as_deref().unwrap_or("")));
                        parameters.push(Param {
                            name,
                            span: self.lines.span(&splat.location()),
                            default: None,
                        });
                    }
                    None => self.unnamed(&rest, &mut parameters, &mut written),
                }
            }
            for parameter in node.posts().iter() {
                self.positional(&parameter, &mut parameters, &mut written);
            }
            for parameter in node.keywords().iter() {
                if let Some(keyword) = parameter.as_required_keyword_parameter_node() {
                    let name = self.text(keyword.name().as_slice());
                    written.push(format!("{name}:"));
                    parameters.push(Param {
                        name: Some(name),
                        span: self.lines.span(&keyword.location()),
                        default: None,
                    });
                } else if let Some(keyword) = parameter.as_optional_keyword_parameter_node() {
                    let name = self.text(keyword.name().as_slice());
                    written.push(format!("[{name}:]"));
                    let default = self.literal(&keyword.value());
                    parameters.push(Param {
                        name: Some(name),
                        span: self.lines.span(&keyword.location()),
                        default,
                    });
                } else {
                    self.unnamed(&parameter, &mut parameters, &mut written);
                }
            }
            if let Some(rest) = node.keyword_rest() {
                if let Some(splat) = rest.as_keyword_rest_parameter_node() {
                    let name = splat.name().map(|name| self.text(name.as_slice()));
                    written.push(format!("**{}", name.as_deref().unwrap_or("")));
                    parameters.push(Param {
                        name,
                        span: self.lines.span(&splat.location()),
                        default: None,
                    });
                } else if rest.as_no_keywords_parameter_node().is_some() {
                    // `**nil` says the method takes no keywords: part of how it
                    // is called, and not a parameter.
                    written.push("**nil".to_owned());
                } else {
                    // `...` forwards everything and names nothing.
                    self.unnamed(&rest, &mut parameters, &mut written);
                }
            }
            if let Some(block) = node.block() {
                let name = block.name().map(|name| self.text(name.as_slice()));
                written.push(format!("&{}", name.as_deref().unwrap_or("")));
                parameters.push(Param {
                    name,
                    span: self.lines.span(&block.location()),
                    default: None,
                });
            }
        }
        let receiver = if singleton { "self." } else { "" };
        (parameters, format!("{receiver}{name}({})", written.join(", ")))
    }

    fn positional(&mut self, parameter: &Node<'_>, parameters: &mut Vec<Param>, written: &mut Vec<String>) {
        match parameter.as_required_parameter_node() {
            Some(required) => {
                let name = self.text(required.name().as_slice());
                written.push(name.clone());
                parameters.push(Param {
                    name: Some(name),
                    span: self.lines.span(&required.location()),
                    default: None,
                });
            }
            None => self.unnamed(parameter, parameters, written),
        }
    }

    /// A destructured position `(a, b)` or `...`: written as the source has it.
    fn unnamed(&mut self, parameter: &Node<'_>, parameters: &mut Vec<Param>, written: &mut Vec<String>) {
        let location = parameter.location();
        written.push(self.source_of(&location));
        parameters.push(Param {
            name: None,
            span: self.lines.span(&location),
            default: None,
        });
    }

    /// Marks the side of the type being read that gains methods at run time.
    fn dynamic(&mut self, singleton: bool) {
        let scope = &mut self.scopes[self.scope];
        if singleton {
            scope.dynamic_singleton = true;
        } else {
            scope.dynamic_instance = true;
        }
    }

    /// Records a method and walks its body as that method's own.
    fn method(
        &mut self,
        name: String,
        singleton: bool,
        span: Span,
        parameters: Vec<Param>,
        signature: String,
        walk: impl FnOnce(&mut Self),
    ) {
        if matches!(name.as_str(), "method_missing" | "respond_to_missing?") {
            self.dynamic(singleton);
        }
        let index = self.scopes[self.scope].methods.len();
        let comment = self.doc_above(span.0);
        let module_function = self.module_function && !singleton;
        self.open_frame(&parameters);
        self.scopes[self.scope].methods.push(MethodDecl {
            name,
            singleton,
            span,
            signature,
            parameters,
            comment,
            cyclomatic: 1,
            module_function,
        });
        let outer = (self.owner, self.on_class);
        self.owner = Owner::Method(self.scope, index);
        self.on_class = singleton;
        self.branches.push(0);
        self.context.push(Context::Def);
        walk(self);
        self.context.pop();
        let branches = self.branches.pop().unwrap_or(0);
        self.scopes[self.scope].methods[index].cyclomatic = 1 + branches;
        (self.owner, self.on_class) = outer;
        self.close_frame();
    }

    /// Walks a body whose `self` no key names.
    fn unkeyed_body(&mut self, walk: impl FnOnce(&mut Self)) {
        self.unkeyed += 1;
        self.context.push(Context::Def);
        self.frames.push(Frame::default());
        walk(self);
        self.frames.pop();
        self.context.pop();
        self.unkeyed -= 1;
    }
}

/// Canonical decimal text, as core's `Literal` wants a number.
fn is_decimal(text: &str) -> bool {
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let (mantissa, exponent) = match unsigned.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, Some(exponent)),
        None => (unsigned, None),
    };
    let (integer, fraction) = match mantissa.split_once('.') {
        Some((integer, fraction)) => (integer, Some(fraction)),
        None => (mantissa, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    digits(integer)
        && (integer == "0" || !integer.starts_with('0'))
        && fraction.is_none_or(digits)
        && exponent.is_none_or(|e| digits(e.strip_prefix(['+', '-']).unwrap_or(e)))
}

impl<'pr> Visit<'pr> for Walker<'_> {
    fn visit_class_node(&mut self, node: &ClassNode<'pr>) {
        let span = self.lines.span(&node.location());
        let mut scope = self.type_scope(ScopeKind::Class, &node.constant_path(), span);
        let mut computed = None;
        // `< Struct.new(:a)`: the inheritance says `Struct`; only what the call is GIVEN is read.
        let mut given: Vec<Node<'pr>> = Vec::new();
        if let Some(expression) = node.superclass() {
            if let Some(path) = self.const_path(&expression) {
                scope.superclass = Superclass::Constant(ConstRef {
                    path,
                    span: self.lines.span(&expression.location()),
                });
            } else {
                let call_span = self.lines.span(&expression.location());
                scope.superclass = match (synthetic_of(&expression), expression.as_call_node()) {
                    // `class Money < Struct.new(:cents)`: Money is a Struct with those members.
                    (Some(kind @ (Synthetic::Struct | Synthetic::Data)), Some(call)) => {
                        scope.members = self.members(&call);
                        given.extend(
                            call.arguments()
                                .iter()
                                .flat_map(|arguments| arguments.arguments().iter()),
                        );
                        given.extend(call.block());
                        Superclass::Core(
                            if matches!(kind, Synthetic::Struct) {
                                "Struct"
                            } else {
                                "Data"
                            },
                            call_span,
                        )
                    }
                    _ => {
                        computed = Some(expression);
                        Superclass::Computed
                    }
                };
            }
        }
        if scope.kind == ScopeKind::Opaque {
            scope.superclass = Superclass::None;
        }
        scope.wrapper =
            scope.kind == ScopeKind::Class && scope.superclass == Superclass::None && body_is_wrapper(node.body());
        let keyed = scope.kind != ScopeKind::Opaque;
        let index = self.scopes.len();
        self.scopes.push(scope);
        self.qualifier(index, &node.constant_path());
        // What a computed superclass writes is evaluated where the class is
        // written, and is the class's own doing.
        given.extend(computed);
        if !given.is_empty() {
            let outer = self.owner;
            if keyed {
                self.owner = Owner::Type(index);
            }
            for expression in &given {
                self.visit(expression);
            }
            self.owner = outer;
        }
        self.enter_at(index, node.body());
    }

    fn visit_module_node(&mut self, node: &ModuleNode<'pr>) {
        let span = self.lines.span(&node.location());
        let mut scope = self.type_scope(ScopeKind::Module, &node.constant_path(), span);
        scope.wrapper = scope.kind == ScopeKind::Module && body_is_wrapper(node.body());
        let index = self.scopes.len();
        self.scopes.push(scope);
        self.qualifier(index, &node.constant_path());
        self.enter_at(index, node.body());
    }

    fn visit_singleton_class_node(&mut self, node: &SingletonClassNode<'pr>) {
        let on_self = node.expression().as_self_node().is_some();
        let in_type_body = matches!(self.scopes[self.scope].kind, ScopeKind::Class | ScopeKind::Module)
            && self.context.last() == Some(&Context::Body);
        if on_self && in_type_body {
            // `class << self`: its `def`s are singleton methods of the type.
            self.singleton_depth += 1;
            self.context.push(Context::Body);
            if let Some(body) = node.body() {
                self.visit(&body);
            }
            self.context.pop();
            self.singleton_depth -= 1;
        } else {
            // `class << obj`, or `class << self` on a file's `main`: `obj` is
            // evaluated here, its singleton's body is nobody's the model can name.
            if !on_self {
                self.visit(&node.expression());
            }
            let scope = new_scope(
                ScopeKind::Opaque,
                Some(self.scope),
                None,
                self.lines.span(&node.location()),
            );
            self.enter(scope, node.body());
        }
    }

    fn visit_def_node(&mut self, node: &DefNode<'pr>) {
        let name = self.text(node.name().as_slice());
        let singleton = match node.receiver() {
            None => Some(self.singleton_depth > 0),
            Some(receiver) if receiver.as_self_node().is_some() => Some(true),
            // `def obj.x`, `def Foo.x`: a singleton method of a value.
            Some(_) => None,
        };
        let opaque = self.scopes[self.scope].kind == ScopeKind::Opaque;
        match singleton {
            Some(singleton) if !opaque && self.keyed() => {
                let (parameters, signature) = self.parameters(&name, singleton, node.parameters());
                let span = self.lines.span(&node.location());
                // `def self.included(base)`: Ruby calls it with whatever includes the module.
                let hook = singleton && name == "included" && self.scopes[self.scope].kind == ScopeKind::Module;
                let base = parameters.first().and_then(|first| first.name.clone()).filter(|_| hook);
                self.method(name, singleton, span, parameters, signature, |walker| {
                    let outer = std::mem::replace(&mut walker.hook_param, base);
                    ruby_prism::visit_def_node(walker, node);
                    walker.hook_param = outer;
                });
            }
            _ => {
                let reason = if opaque { "def-in-opaque-body" } else { "def-on-object" };
                let line = self.lines.line(node.location().start_offset());
                self.drop(reason, line, &name);
                // `def obj.x`: `obj` is evaluated here, in the enclosing body.
                if let Some(receiver) = node.receiver() {
                    self.visit(&receiver);
                }
                self.unkeyed_body(|walker| {
                    if let Some(parameters) = node.parameters() {
                        walker.visit_parameters_node(&parameters);
                    }
                    if let Some(body) = node.body() {
                        walker.visit(&body);
                    }
                });
            }
        }
    }

    fn visit_block_node(&mut self, node: &BlockNode<'pr>) {
        // A block parameter can be passed anything: it types nothing.
        let parameters = node
            .parameters()
            .and_then(|parameters| parameters.as_block_parameters_node())
            .and_then(|parameters| parameters.parameters());
        let (parameters, _) = self.parameters("", false, parameters);
        for parameter in parameters {
            if let Some(name) = parameter.name {
                self.assign_local(name, None);
            }
        }
        self.context.push(Context::Block);
        ruby_prism::visit_block_node(self, node);
        self.context.pop();
    }

    fn visit_lambda_node(&mut self, node: &LambdaNode<'pr>) {
        self.context.push(Context::Block);
        ruby_prism::visit_lambda_node(self, node);
        self.context.pop();
    }

    fn visit_call_node(&mut self, node: &ruby_prism::CallNode<'pr>) {
        let name = node.name().as_slice();
        let implicit_self = match node.receiver() {
            None => true,
            Some(receiver) => receiver.as_self_node().is_some(),
        };
        let on_kernel = match node.receiver() {
            None => true,
            Some(receiver) => receiver
                .as_constant_read_node()
                .is_some_and(|c| c.name().as_slice() == b"Kernel"),
        };
        let span = self.lines.span(&node.location());
        // A call is anchored where its name is written — not at a receiver
        // three lines up, nor across the block it is given.
        let at = node
            .message_loc()
            .map(|message| self.lines.span(&message))
            .unwrap_or((span.0, span.0));
        let first = node
            .arguments()
            .and_then(|arguments| arguments.arguments().iter().next());

        self.hook_call(node, name);
        // A concern's two blocks, read as ActiveSupport::Concern defines them.
        let in_concern = implicit_self
            && self.singleton_depth == 0
            && self.context.last() == Some(&Context::Body)
            && self.scopes[self.scope].kind == ScopeKind::Module
            && self.scopes[self.scope].concern;
        let block = node.block().and_then(|block| block.as_block_node());
        if in_concern
            && name == b"class_methods"
            && let Some(block) = &block
        {
            // `class_methods do … end` IS the body of the concern's `ClassMethods` module.
            let path = ConstPath::simple("ClassMethods".to_owned());
            let mut scope = new_scope(ScopeKind::Module, Some(self.scope), Some(path), span);
            scope.comment = self.doc_above(span.0);
            return self.enter(scope, block.body());
        }
        let included_block = in_concern && name == b"included" && block.is_some();

        match name {
            b"require" | b"require_relative" | b"load" | b"autoload" if on_kernel || implicit_self => {
                self.require(node, name);
                return ruby_prism::visit_call_node(self, node);
            }
            // Each guard records the declaration; where it is none, this is a call like any other.
            b"include" | b"prepend" | b"extend" if implicit_self && self.mixin(node, name) => {
                // The constants it names are the mixin, not a second reference.
                for argument in node
                    .arguments()
                    .iter()
                    .flat_map(|arguments| arguments.arguments().iter())
                {
                    if !is_const_path(&argument) {
                        self.visit(&argument);
                    }
                }
                return;
            }
            b"attr_reader" | b"attr_writer" | b"attr_accessor" | b"attr"
                if implicit_self && self.attributes(node, name) =>
            {
                return;
            }
            b"alias_method" if implicit_self && self.context.last() == Some(&Context::Body) => {
                let names: Vec<Option<String>> = node
                    .arguments()
                    .iter()
                    .flat_map(|arguments| arguments.arguments().iter())
                    .map(|argument| self.name_literal(&argument))
                    .collect();
                if let [new_name, old_name] = names.as_slice() {
                    self.alias(at.0, new_name.clone(), old_name.clone());
                    return;
                }
            }
            b"module_function" if implicit_self && self.context.last() == Some(&Context::Body) => {
                match node.arguments() {
                    None => self.module_function = true,
                    Some(arguments) => {
                        for argument in arguments.arguments().iter() {
                            if let Some(name) = self.name_literal(&argument) {
                                for method in self.scopes[self.scope].methods.iter_mut().filter(|m| m.name == name) {
                                    method.module_function = true;
                                }
                            }
                        }
                    }
                }
                return;
            }
            b"define_method" | b"define_singleton_method"
                if implicit_self
                    && self.keyed()
                    && self.on_class
                    && matches!(self.scopes[self.scope].kind, ScopeKind::Class | ScopeKind::Module) =>
            {
                let block = node.block().and_then(|block| block.as_block_node());
                // `self` is the class here: `define_method` defines for its instances.
                let singleton = self.singleton_depth > 0 || name == b"define_singleton_method";
                match first.as_ref().and_then(|first| self.name_literal(first)) {
                    Some(method_name) => {
                        let block_parameters = block
                            .as_ref()
                            .and_then(|block| block.parameters())
                            .and_then(|parameters| parameters.as_block_parameters_node())
                            .and_then(|parameters| parameters.parameters());
                        let (parameters, signature) = self.parameters(&method_name, singleton, block_parameters);
                        self.method(method_name, singleton, span, parameters, signature, |walker| {
                            if let Some(body) = block.as_ref().and_then(|block| block.body()) {
                                walker.visit(&body);
                            }
                        });
                        return;
                    }
                    None => {
                        // A name computed at run time: this type has methods no key can name.
                        self.dynamic(singleton);
                        self.drop_call("computed-define-method", node);
                    }
                }
            }
            b"raise" | b"fail" if on_kernel && self.keyed() => {
                if let Some(first) = &first {
                    let raised = match self.const_path(first).or_else(|| self.instantiated(first)) {
                        Some(path) => Some(Some(path)),
                        None if first.as_string_node().is_some() || first.as_interpolated_string_node().is_some() => {
                            Some(None)
                        }
                        // `raise error`: a value, whose class the source does not say.
                        None => None,
                    };
                    match raised {
                        Some(raised) => {
                            self.site(at, What::Raise(raised));
                        }
                        None => self.drop_call("raise-of-a-value", node),
                    }
                }
            }
            b"method" | b"instance_method" | b"public_method" => {
                if let Some(method_name) = first.as_ref().and_then(|first| self.name_literal(first)) {
                    let receiver = self.receiver(node);
                    self.call_site(at, receiver, method_name, true);
                    return ruby_prism::visit_call_node(self, node);
                }
            }
            b"send" | b"public_send" | b"__send__" => {
                let receiver = self.receiver(node);
                match first.as_ref().and_then(|first| self.name_literal(first)) {
                    // A literal name is a call like any other.
                    Some(method_name) => self.call_site(at, receiver, method_name, false),
                    None => self.drop_call("dynamic-dispatch", node),
                }
                return ruby_prism::visit_call_node(self, node);
            }
            _ => {}
        }

        let receiver = self.receiver(node);
        let method_name = self.text(name);
        self.call_site(at, receiver, method_name, false);
        // `included do … end` runs in whatever includes the concern: its own
        // statements sit one block deeper than this call.
        let outer = self.hook_block;
        if included_block {
            self.hook_block = Some(self.context.len() + 1);
        }
        ruby_prism::visit_call_node(self, node);
        self.hook_block = outer;
    }

    fn visit_super_node(&mut self, node: &SuperNode<'pr>) {
        if self.keyed() {
            let line = self.lines.line(node.location().start_offset());
            self.site((line, line), What::Super);
        }
        ruby_prism::visit_super_node(self, node);
    }

    fn visit_forwarding_super_node(&mut self, node: &ForwardingSuperNode<'pr>) {
        if self.keyed() {
            let line = self.lines.line(node.location().start_offset());
            self.site((line, line), What::Super);
        }
        ruby_prism::visit_forwarding_super_node(self, node);
    }

    fn visit_alias_method_node(&mut self, node: &AliasMethodNode<'pr>) {
        let new_name = self.name_literal(&node.new_name());
        let old_name = self.name_literal(&node.old_name());
        let line = self.lines.line(node.location().start_offset());
        self.alias(line, new_name, old_name);
    }

    fn visit_constant_read_node(&mut self, node: &ConstantReadNode<'pr>) {
        let name = self.text(node.name().as_slice());
        let span = self.lines.span(&node.location());
        self.site(span, What::Constant(ConstPath::simple(name)));
    }

    fn visit_constant_path_node(&mut self, node: &ConstantPathNode<'pr>) {
        match self.const_path_node(node) {
            // ONE site for the whole path: `A::B::C` is not also a read of `A::B`.
            Some(path) => {
                let span = self.lines.span(&node.location());
                self.site(span, What::Constant(path));
            }
            None => ruby_prism::visit_constant_path_node(self, node),
        }
    }

    fn visit_constant_write_node(&mut self, node: &ConstantWriteNode<'pr>) {
        let name = self.text(node.name().as_slice());
        let span = self.lines.span(&node.location());
        let value = node.value();
        let nameable = self.singleton_depth == 0 && self.scopes[self.scope].kind != ScopeKind::Opaque;
        match synthetic_of(&value) {
            Some(kind) if nameable => self.synthetic_type(name, span, kind, &value),
            _ => self.constant_decl(ConstPath::simple(name), span, &value),
        }
    }

    fn visit_constant_or_write_node(&mut self, node: &ConstantOrWriteNode<'pr>) {
        let name = self.text(node.name().as_slice());
        let span = self.lines.span(&node.location());
        self.constant_decl(ConstPath::simple(name), span, &node.value());
    }

    fn visit_constant_path_write_node(&mut self, node: &ConstantPathWriteNode<'pr>) {
        let span = self.lines.span(&node.location());
        match self.const_path_node(&node.target()) {
            Some(path) => self.constant_decl(path, span, &node.value()),
            None => self.visit(&node.value()),
        }
    }

    fn visit_constant_path_or_write_node(&mut self, node: &ConstantPathOrWriteNode<'pr>) {
        let span = self.lines.span(&node.location());
        match self.const_path_node(&node.target()) {
            Some(path) => self.constant_decl(path, span, &node.value()),
            None => self.visit(&node.value()),
        }
    }

    // ---- locals: what a body assigns types the receivers it calls ----

    fn visit_local_variable_write_node(&mut self, node: &LocalVariableWriteNode<'pr>) {
        let name = self.text(node.name().as_slice());
        let class = self.instantiated(&node.value());
        self.assign_local(name, class);
        ruby_prism::visit_local_variable_write_node(self, node);
    }

    fn visit_local_variable_or_write_node(&mut self, node: &LocalVariableOrWriteNode<'pr>) {
        let name = self.text(node.name().as_slice());
        let class = self.instantiated(&node.value());
        self.assign_local(name, class);
        ruby_prism::visit_local_variable_or_write_node(self, node);
    }

    fn visit_local_variable_and_write_node(&mut self, node: &LocalVariableAndWriteNode<'pr>) {
        let name = self.text(node.name().as_slice());
        self.assign_local(name, None);
        ruby_prism::visit_local_variable_and_write_node(self, node);
    }

    fn visit_local_variable_operator_write_node(&mut self, node: &LocalVariableOperatorWriteNode<'pr>) {
        let name = self.text(node.name().as_slice());
        self.assign_local(name, None);
        ruby_prism::visit_local_variable_operator_write_node(self, node);
    }

    fn visit_local_variable_target_node(&mut self, node: &LocalVariableTargetNode<'pr>) {
        // `a, b = …`, `rescue => e`, `for x in …`: assigned something unknown.
        let name = self.text(node.name().as_slice());
        self.assign_local(name, None);
    }

    // ---- instance and class variables: the fields a type has ----

    fn visit_instance_variable_read_node(&mut self, node: &InstanceVariableReadNode<'pr>) {
        self.variable(node.name().as_slice(), &node.location(), true, false, None);
    }

    fn visit_instance_variable_write_node(&mut self, node: &InstanceVariableWriteNode<'pr>) {
        let assigned = self.assigned(&node.value());
        self.variable(node.name().as_slice(), &node.name_loc(), false, true, assigned);
        ruby_prism::visit_instance_variable_write_node(self, node);
    }

    fn visit_instance_variable_or_write_node(&mut self, node: &InstanceVariableOrWriteNode<'pr>) {
        // `@repo ||= Repo.new`: the memoization idiom types `@repo` as a write does.
        let assigned = self.assigned(&node.value());
        self.variable(node.name().as_slice(), &node.name_loc(), true, true, assigned);
        ruby_prism::visit_instance_variable_or_write_node(self, node);
    }

    fn visit_instance_variable_and_write_node(&mut self, node: &InstanceVariableAndWriteNode<'pr>) {
        self.variable(
            node.name().as_slice(),
            &node.name_loc(),
            true,
            true,
            Some(Assigned::Other),
        );
        ruby_prism::visit_instance_variable_and_write_node(self, node);
    }

    fn visit_instance_variable_operator_write_node(&mut self, node: &InstanceVariableOperatorWriteNode<'pr>) {
        self.variable(
            node.name().as_slice(),
            &node.name_loc(),
            true,
            true,
            Some(Assigned::Other),
        );
        ruby_prism::visit_instance_variable_operator_write_node(self, node);
    }

    fn visit_instance_variable_target_node(&mut self, node: &InstanceVariableTargetNode<'pr>) {
        self.variable(
            node.name().as_slice(),
            &node.location(),
            false,
            true,
            Some(Assigned::Other),
        );
    }

    fn visit_class_variable_read_node(&mut self, node: &ClassVariableReadNode<'pr>) {
        self.variable(node.name().as_slice(), &node.location(), true, false, None);
    }

    fn visit_class_variable_write_node(&mut self, node: &ClassVariableWriteNode<'pr>) {
        let assigned = self.assigned(&node.value());
        self.variable(node.name().as_slice(), &node.name_loc(), false, true, assigned);
        ruby_prism::visit_class_variable_write_node(self, node);
    }

    fn visit_class_variable_or_write_node(&mut self, node: &ClassVariableOrWriteNode<'pr>) {
        let assigned = self.assigned(&node.value());
        self.variable(node.name().as_slice(), &node.name_loc(), true, true, assigned);
        ruby_prism::visit_class_variable_or_write_node(self, node);
    }

    fn visit_class_variable_and_write_node(&mut self, node: &ClassVariableAndWriteNode<'pr>) {
        self.variable(
            node.name().as_slice(),
            &node.name_loc(),
            true,
            true,
            Some(Assigned::Other),
        );
        ruby_prism::visit_class_variable_and_write_node(self, node);
    }

    fn visit_class_variable_operator_write_node(&mut self, node: &ClassVariableOperatorWriteNode<'pr>) {
        self.variable(
            node.name().as_slice(),
            &node.name_loc(),
            true,
            true,
            Some(Assigned::Other),
        );
        ruby_prism::visit_class_variable_operator_write_node(self, node);
    }

    fn visit_class_variable_target_node(&mut self, node: &ClassVariableTargetNode<'pr>) {
        self.variable(
            node.name().as_slice(),
            &node.location(),
            false,
            true,
            Some(Assigned::Other),
        );
    }

    // ---- branches: what `cyclomatic` counts ----

    fn visit_if_node(&mut self, node: &IfNode<'pr>) {
        self.branch();
        ruby_prism::visit_if_node(self, node);
    }

    fn visit_unless_node(&mut self, node: &UnlessNode<'pr>) {
        self.branch();
        ruby_prism::visit_unless_node(self, node);
    }

    fn visit_while_node(&mut self, node: &WhileNode<'pr>) {
        self.branch();
        ruby_prism::visit_while_node(self, node);
    }

    fn visit_until_node(&mut self, node: &UntilNode<'pr>) {
        self.branch();
        ruby_prism::visit_until_node(self, node);
    }

    fn visit_for_node(&mut self, node: &ForNode<'pr>) {
        self.branch();
        ruby_prism::visit_for_node(self, node);
    }

    fn visit_when_node(&mut self, node: &WhenNode<'pr>) {
        self.branch();
        ruby_prism::visit_when_node(self, node);
    }

    fn visit_in_node(&mut self, node: &InNode<'pr>) {
        self.branch();
        ruby_prism::visit_in_node(self, node);
    }

    fn visit_rescue_node(&mut self, node: &RescueNode<'pr>) {
        self.branch();
        ruby_prism::visit_rescue_node(self, node);
    }

    fn visit_rescue_modifier_node(&mut self, node: &RescueModifierNode<'pr>) {
        self.branch();
        ruby_prism::visit_rescue_modifier_node(self, node);
    }

    fn visit_and_node(&mut self, node: &AndNode<'pr>) {
        self.branch();
        ruby_prism::visit_and_node(self, node);
    }

    fn visit_or_node(&mut self, node: &OrNode<'pr>) {
        self.branch();
        ruby_prism::visit_or_node(self, node);
    }
}

#[cfg(test)]
mod tests;
