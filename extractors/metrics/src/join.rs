//! One source file: bca's space tree joined to the model's measured entities
//! on their anchors, then each joined entity's measures.
//!
//! The model and bca disagree on granularity in both directions — a C#
//! property with accessors is one entity over two spaces, an Elixir function
//! is one entity over one space per clause, a callback nobody names is a
//! space with no entity — so the join has three kinds of match and one rule
//! for what is left over:
//!
//! - EXACT: entities and spaces with the same line span. Natural pairs first
//!   (an invocable and a function, a type and a class, a module and the
//!   file), each kind's entities and spaces paired outermost to outermost
//!   when their numbers agree; then what is left, by depth alone (a one-line
//!   C# property and the lambda in it). More entities than spaces leaves the
//!   innermost unjoined (a Java class and the implicit constructor anchored
//!   on it); more spaces than entities joins none of them.
//! - LEADING: the same last line, first lines apart by nothing but
//!   annotation, attribute, decorator, comment or blank lines — what one
//!   side counts as part of the declaration and the other does not (Spoon
//!   starts a method after `@Override`, tree-sitter at it; the TypeScript
//!   compiler starts a class at its decorator, tree-sitter after it).
//! - CONTAINED: an entity no space spans takes the outermost unjoined,
//!   compatible spaces inside its span — an Elixir function's clauses, a C#
//!   property's accessors. Never an entity anchored exactly where its parent
//!   is (an implicit constructor on its class): it has no extent of its own
//!   to contain anything.
//! - FOLD: a space no entity joined is charged to the nearest joined space
//!   above it — the rule every extractor's `cyclomatic` already follows (a
//!   lambda the model names is its own invocable; a closure it does not
//!   name belongs to its enclosing one).

use std::collections::HashMap;

use big_code_analysis::{FuncSpace, LANG, MetricsOptions, Source, SpaceKind, analyze};

use crate::model::{Category, Measurable};
use crate::number::measure;

/// Keys this binary writes, and the only ones it ever removes. The
/// extractor's own keys (`sloc`, `cyclomatic`) are never touched.
pub const KEYS: &[&str] = &[
    "abc.assignments",
    "abc.branches",
    "abc.conditions",
    "abc.magnitude",
    "cloc",
    "cognitive",
    "halstead.difficulty",
    "halstead.effort",
    "halstead.volume",
    "lloc",
    "mi",
    "nexits",
    "npa",
    "npm",
];

/// How an entity met its space(s).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Join {
    Exact,
    Leading,
    Contained,
    /// Several entities and spaces on one span that do not pair up.
    Ambiguous,
    /// No space on the span, beside it or inside it.
    Unjoined,
}

/// One entity's outcome.
pub struct Measured {
    pub entity: u32,
    pub join: Join,
    /// `(key, JSON number)`, a subset of [`KEYS`], sorted.
    pub values: Vec<(&'static str, String)>,
    /// bca's `ploc` of the exactly joined space — lines holding code, the
    /// same definition as the model's `sloc` — so a report can check the join.
    pub ploc: Option<u64>,
}

/// Additive values charged to a space: its own, plus every unjoined space below it.
#[derive(Clone, Copy, Default)]
struct Charged {
    cognitive: u64,
    nexits: u64,
    assignments: u64,
    branches: u64,
    conditions: u64,
}

impl Charged {
    fn own(space: &FuncSpace) -> Self {
        let m = &space.metrics;
        Self {
            cognitive: m.cognitive.cognitive(),
            nexits: m.nexits.nexits(),
            assignments: m.abc.assignments(),
            branches: m.abc.branches(),
            conditions: m.abc.conditions(),
        }
    }

    fn add(&mut self, other: &Self) {
        self.cognitive += other.cognitive;
        self.nexits += other.nexits;
        self.assignments += other.assignments;
        self.branches += other.branches;
        self.conditions += other.conditions;
    }
}

struct Flat<'s> {
    space: &'s FuncSpace,
    parent: Option<usize>,
    depth: u32,
}

impl Flat<'_> {
    fn span(&self) -> (u32, u32) {
        (self.space.start_line as u32, self.space.end_line as u32)
    }
}

/// Pre-order: a parent always precedes its children.
fn flatten(root: &FuncSpace) -> Vec<Flat<'_>> {
    let mut out = Vec::new();
    let mut stack = vec![(root, None, 0u32)];
    while let Some((space, parent, depth)) = stack.pop() {
        let at = out.len();
        out.push(Flat { space, parent, depth });
        for child in space.spaces.iter().rev() {
            stack.push((child, Some(at), depth + 1));
        }
    }
    out
}

/// What a space may be joined to beyond an exact span. An invocable may be a
/// class space: Java's anonymous class is a `lambda`-kind invocable.
fn compatible(category: Category, kind: SpaceKind) -> bool {
    match category {
        Category::Unit => kind == SpaceKind::Unit,
        Category::Invocable => matches!(kind, SpaceKind::Function | SpaceKind::Class),
        Category::Type => !matches!(kind, SpaceKind::Function | SpaceKind::Unit | SpaceKind::Unknown),
        Category::Other => !matches!(kind, SpaceKind::Unit | SpaceKind::Unknown),
    }
}

/// The pairs no one would argue with.
fn natural(category: Category, kind: SpaceKind) -> bool {
    match category {
        Category::Unit => kind == SpaceKind::Unit,
        Category::Invocable => kind == SpaceKind::Function,
        Category::Type => matches!(
            kind,
            SpaceKind::Class
                | SpaceKind::Struct
                | SpaceKind::Trait
                | SpaceKind::Impl
                | SpaceKind::Interface
                | SpaceKind::Namespace
        ),
        Category::Other => false,
    }
}

/// Whether `gap` — the lines between a declaration's two possible starts —
/// holds nothing but annotations, attributes, decorators, comments and
/// blanks. An annotation's arguments may run over several lines
/// (`@RequestMapping(value = …,\n method = …)`): a line inside an open
/// bracket continues it, and the gap must close every bracket it opens.
fn is_leading_gap(gap: &[&str]) -> bool {
    let mut depth = 0i32;
    for line in gap {
        let line = line.trim_start();
        let comment = ["//", "/*", "*", "#"].iter().any(|p| line.starts_with(p));
        let opens = line.is_empty() || comment || line.starts_with('@') || line.starts_with('[');
        if depth == 0 && !opens {
            return false;
        }
        if !comment {
            depth += bracket_balance(line);
        }
    }
    depth == 0
}

/// Opening minus closing brackets outside string and character literals.
fn bracket_balance(line: &str) -> i32 {
    let mut balance = 0;
    let mut quote: Option<char> = None;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(_), '\\') => {
                chars.next();
            }
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '(' | '[' | '{') => balance += 1,
            (None, ')' | ']' | '}') => balance -= 1,
            (None, _) => {}
        }
    }
    balance
}

/// The language a model file is parsed as, from the header's `lang` and the
/// file's extension; `None` for a language this binary does not measure.
pub fn language(lang: &str, path: &str) -> Option<LANG> {
    match lang {
        "java" => Some(LANG::Java),
        "csharp" => Some(LANG::Csharp),
        "ex" => Some(LANG::Elixir),
        "ts" if path.ends_with(".tsx") => Some(LANG::Tsx),
        "ts" => Some(LANG::Typescript),
        _ => None,
    }
}

/// Parses `code` and measures `targets`, all anchored in this file.
pub fn measure_file(lang: LANG, code: &[u8], targets: &[Measurable]) -> Result<Vec<Measured>, String> {
    let root = analyze(Source::new(lang, code), MetricsOptions::default()).map_err(|e| e.to_string())?;
    let spaces = flatten(&root);
    let text = String::from_utf8_lossy(code);
    let lines: Vec<&str> = text.lines().collect();
    Ok(join(&spaces, &lines, targets))
}

fn join(spaces: &[Flat<'_>], lines: &[&str], targets: &[Measurable]) -> Vec<Measured> {
    // Which target each space is charged to, and how each target joined.
    let mut owner: Vec<Option<usize>> = vec![None; spaces.len()];
    let mut how: Vec<Join> = vec![Join::Unjoined; targets.len()];

    exact(spaces, targets, &mut owner, &mut how);
    leading(spaces, lines, targets, &mut owner, &mut how);
    contained(spaces, targets, &mut owner, &mut how);

    // FOLD, bottom-up: pre-order reversed visits every child before its parent.
    let mut charged: Vec<Charged> = spaces.iter().map(|f| Charged::own(f.space)).collect();
    for s in (1..spaces.len()).rev() {
        if owner[s].is_none() {
            let parent = spaces[s].parent.expect("only the root has no parent");
            let child = charged[s];
            charged[parent].add(&child);
        }
    }
    let mut per_target: Vec<Charged> = vec![Charged::default(); targets.len()];
    // The one space an Exact or Leading entity IS; a Contained one has several.
    let mut sole_space: Vec<Option<usize>> = vec![None; targets.len()];
    for (s, o) in owner.iter().enumerate() {
        if let Some(t) = *o {
            per_target[t].add(&charged[s]);
            if matches!(how[t], Join::Exact | Join::Leading) {
                sole_space[t] = Some(s);
            }
        }
    }

    targets
        .iter()
        .enumerate()
        .map(|(t, target)| {
            let mut values = Vec::new();
            if matches!(how[t], Join::Exact | Join::Leading | Join::Contained) {
                charged_values(&per_target[t], &mut values);
            }
            let sole = sole_space[t].map(|s| spaces[s].space);
            if let Some(space) = sole {
                span_values(space, target.category, &mut values);
            }
            values.sort_unstable_by_key(|(k, _)| *k);
            let ploc = sole.filter(|_| how[t] == Join::Exact).map(|s| s.metrics.loc.ploc());
            Measured {
                entity: target.entity,
                join: how[t],
                values,
                ploc,
            }
        })
        .collect()
}

/// EXACT, one span at a time (see the module comment for the two rounds).
fn exact(spaces: &[Flat<'_>], targets: &[Measurable], owner: &mut [Option<usize>], how: &mut [Join]) {
    let mut by_span: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (s, flat) in spaces.iter().enumerate() {
        if flat.space.kind != SpaceKind::Unknown {
            by_span.entry(flat.span()).or_default().push(s);
        }
    }
    let mut groups: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (t, target) in targets.iter().enumerate() {
        groups.entry((target.start, target.end)).or_default().push(t);
    }
    let mut spans: Vec<_> = groups.keys().copied().collect();
    spans.sort_unstable();
    for span in spans {
        let Some(on_span) = by_span.get(&span) else { continue };
        let mut members = groups.remove(&span).expect("span taken from the map");
        let mut candidates = on_span.clone();
        members.sort_by_key(|&t| (targets[t].depth, targets[t].entity));
        candidates.sort_by_key(|&s| (spaces[s].depth, s));

        // Round one: natural pairs, one category at a time.
        for category in [Category::Unit, Category::Invocable, Category::Type] {
            let ms: Vec<usize> = members
                .iter()
                .copied()
                .filter(|&t| targets[t].category == category)
                .collect();
            let cs: Vec<usize> = candidates
                .iter()
                .copied()
                .filter(|&s| natural(category, spaces[s].space.kind))
                .collect();
            if !ms.is_empty() && ms.len() == cs.len() {
                for (&t, &s) in ms.iter().zip(&cs) {
                    owner[s] = Some(t);
                    how[t] = Join::Exact;
                }
                members.retain(|t| !ms.contains(t));
                candidates.retain(|s| !cs.contains(s));
            }
        }

        // Round two: the rest by depth, outermost first.
        if members.is_empty() || candidates.is_empty() {
            continue;
        }
        let fits = members.len() >= candidates.len()
            && members
                .iter()
                .zip(&candidates)
                .all(|(&t, &s)| compatible(targets[t].category, spaces[s].space.kind));
        // One entity over sibling spaces (a C# `{ get; set; }`) contains them.
        let siblings = members.len() == 1
            && candidates
                .iter()
                .all(|&s| spaces[s].depth == spaces[candidates[0]].depth)
            && candidates
                .iter()
                .all(|&s| compatible(targets[members[0]].category, spaces[s].space.kind));
        if fits {
            for (&t, &s) in members.iter().zip(&candidates) {
                owner[s] = Some(t);
                how[t] = Join::Exact;
            }
        } else if siblings {
            for &s in &candidates {
                owner[s] = Some(members[0]);
            }
            how[members[0]] = Join::Contained;
        } else {
            for t in members {
                how[t] = Join::Ambiguous;
            }
        }
    }
}

/// LEADING, outermost entities first: a lambda ending on its method's last
/// line must find the method's space already taken.
fn leading(spaces: &[Flat<'_>], lines: &[&str], targets: &[Measurable], owner: &mut [Option<usize>], how: &mut [Join]) {
    // Lines [from, to) of the file, 1-based.
    let gap_is_leading = |from: u32, to: u32| {
        let (Some(from), Some(to)) = ((from as usize).checked_sub(1), (to as usize).checked_sub(1)) else {
            return false;
        };
        lines.get(from..to).is_some_and(is_leading_gap)
    };
    let mut open: Vec<usize> = (0..targets.len()).filter(|&t| how[t] == Join::Unjoined).collect();
    open.sort_by_key(|&t| {
        (
            std::cmp::Reverse(targets[t].end - targets[t].start),
            targets[t].depth,
            targets[t].entity,
        )
    });
    for t in open {
        let target = &targets[t];
        let nearest = (0..spaces.len())
            .filter(|&s| {
                let (start, end) = spaces[s].span();
                end == target.end
                    && start != target.start
                    && compatible(target.category, spaces[s].space.kind)
                    && gap_is_leading(start.min(target.start), start.max(target.start))
            })
            .min_by_key(|&s| (spaces[s].span().0.abs_diff(target.start), s));
        if let Some(s) = nearest.filter(|&s| owner[s].is_none()) {
            owner[s] = Some(t);
            how[t] = Join::Leading;
        }
    }
}

/// CONTAINED: the outermost unowned compatible spaces inside the span that
/// no other joined space inside the span already encloses. Innermost
/// entities first, so a namespace never takes what a function inside it
/// would have claimed.
fn contained(spaces: &[Flat<'_>], targets: &[Measurable], owner: &mut [Option<usize>], how: &mut [Join]) {
    let mut open: Vec<usize> = (0..targets.len())
        .filter(|&t| how[t] == Join::Unjoined && !targets[t].implicit)
        .collect();
    open.sort_by_key(|&t| {
        (
            targets[t].end - targets[t].start,
            std::cmp::Reverse(targets[t].depth),
            targets[t].entity,
        )
    });
    for t in open {
        let target = &targets[t];
        let inside = |s: usize| {
            let (start, end) = spaces[s].span();
            target.start <= start && end <= target.end
        };
        let mut claimed = false;
        for s in 0..spaces.len() {
            if owner[s].is_some() || !inside(s) || !compatible(target.category, spaces[s].space.kind) {
                continue;
            }
            let mut above = spaces[s].parent;
            let mut enclosed = false;
            while let Some(p) = above.filter(|&p| inside(p)) {
                if owner[p].is_some() {
                    enclosed = true;
                    break;
                }
                above = spaces[p].parent;
            }
            if !enclosed {
                owner[s] = Some(t);
                claimed = true;
            }
        }
        if claimed {
            how[t] = Join::Contained;
        }
    }
}

/// The additive family: valid for one space and for a union of contained spaces.
fn charged_values(c: &Charged, out: &mut Vec<(&'static str, String)>) {
    let magnitude = ((c.assignments.pow(2) + c.branches.pow(2) + c.conditions.pow(2)) as f64).sqrt();
    let mut put = |key, value: f64| {
        if let Some(text) = measure(value) {
            out.push((key, text));
        }
    };
    put("cognitive", c.cognitive as f64);
    put("nexits", c.nexits as f64);
    put("abc.assignments", c.assignments as f64);
    put("abc.branches", c.branches as f64);
    put("abc.conditions", c.conditions as f64);
    put("abc.magnitude", magnitude);
}

/// The span family: measured over one space's whole text, nested spaces
/// included (the way `sloc` is), so only an entity that IS one space has them.
fn span_values(space: &FuncSpace, category: Category, out: &mut Vec<(&'static str, String)>) {
    let m = &space.metrics;
    let mut put = |key, value: f64| {
        if let Some(text) = measure(value) {
            out.push((key, text));
        }
    };
    put("lloc", m.loc.lloc() as f64);
    put("cloc", m.loc.cloc() as f64);
    put("halstead.volume", m.halstead.volume());
    put("halstead.difficulty", m.halstead.difficulty());
    put("halstead.effort", m.halstead.effort());
    // bca answers 0 when MI's inputs are empty (a body-less declaration):
    // that is "not applicable", which the model spells as absence.
    if m.halstead.volume() > 0.0 && m.loc.sloc() > 0 {
        put("mi", m.mi.visual_studio());
    }
    if category == Category::Type {
        put("npm", (m.npm.class_npm() + m.npm.interface_npm()) as f64);
        put("npa", (m.npa.class_npa() + m.npa.interface_npa()) as f64);
    }
}

#[cfg(test)]
mod tests {
    use big_code_analysis::LANG;

    use super::{Join, Measured, is_leading_gap, measure_file};
    use crate::model::{Category, Measurable};

    fn target(entity: u32, category: Category, start: u32, end: u32, depth: u32) -> Measurable {
        Measurable {
            entity,
            file: 0,
            start,
            end,
            category,
            depth,
            implicit: false,
            sloc: None,
            module: 0,
            symbol: format!("e{entity}"),
            disambiguator: None,
        }
    }

    fn outcome(measured: &[Measured], entity: u32) -> &Measured {
        measured
            .iter()
            .find(|m| m.entity == entity)
            .expect("every target has an outcome")
    }

    fn value<'m>(measured: &'m [Measured], entity: u32, key: &str) -> Option<&'m str> {
        outcome(measured, entity)
            .values
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.as_str())
    }

    const JAVA: &str = "\
class A {
    @Override
    public int f(int x) {
        if (x > 0) {
            return 1;
        }
        Runnable r = new Runnable() {
            public void run() {
                if (x > 1) { }
            }
        };
        return 0;
    }
}
";

    #[test]
    fn a_method_anchored_after_its_annotation_joins_the_space_that_starts_at_it() {
        let targets = [
            target(0, Category::Type, 1, 14, 0),
            target(1, Category::Invocable, 3, 13, 1),
        ];
        let measured = measure_file(LANG::Java, JAVA.as_bytes(), &targets).unwrap();
        assert_eq!(outcome(&measured, 0).join, Join::Exact);
        assert_eq!(outcome(&measured, 1).join, Join::Leading);
        assert_eq!(value(&measured, 1, "nexits"), Some("2"));
        assert!(value(&measured, 1, "lloc").is_some(), "one space: the span family too");
    }

    #[test]
    fn a_space_the_model_does_not_name_is_charged_to_the_entity_around_it() {
        let named = [
            target(0, Category::Type, 1, 14, 0),
            target(1, Category::Invocable, 3, 13, 1),
            target(2, Category::Invocable, 8, 10, 3),
        ];
        let unnamed = &named[..2];
        let with = measure_file(LANG::Java, JAVA.as_bytes(), &named).unwrap();
        let without = measure_file(LANG::Java, JAVA.as_bytes(), unnamed).unwrap();
        let cognitive = |m: &[Measured], e| value(m, e, "cognitive").unwrap().parse::<u64>().unwrap();
        assert_eq!(cognitive(&with, 1), 1, "f's own `if`");
        assert!(cognitive(&with, 2) >= 1, "run's `if`");
        assert_eq!(cognitive(&without, 1), cognitive(&with, 1) + cognitive(&with, 2));
    }

    #[test]
    fn an_elixir_function_contains_its_clauses_and_keeps_only_the_additive_measures() {
        let code = "\
defmodule M do
  def f(0), do: :zero
  def f(n) when n > 0 do
    if n > 10, do: :big, else: :small
  end
end
";
        let targets = [
            target(0, Category::Type, 1, 6, 0),
            target(1, Category::Invocable, 2, 5, 1),
        ];
        let measured = measure_file(LANG::Elixir, code.as_bytes(), &targets).unwrap();
        assert_eq!(outcome(&measured, 0).join, Join::Exact);
        assert_eq!(outcome(&measured, 1).join, Join::Contained);
        assert!(value(&measured, 1, "cognitive").is_some());
        for key in ["lloc", "cloc", "halstead.volume", "mi"] {
            assert_eq!(value(&measured, 1, key), None, "{key} is not additive over clauses");
        }
    }

    #[test]
    fn csharp_properties_join_their_accessors_and_their_lambdas() {
        let code = "\
class C {
    public bool Verbose { get; set; }
    public int Count => items.Count(x => x > 0);
}
";
        let targets = [
            target(0, Category::Type, 1, 4, 0),
            target(1, Category::Other, 2, 2, 1),
            target(2, Category::Other, 3, 3, 1),
            target(3, Category::Invocable, 3, 3, 2),
        ];
        let measured = measure_file(LANG::Csharp, code.as_bytes(), &targets).unwrap();
        let joins: Vec<Join> = (0..4).map(|e| outcome(&measured, e).join).collect();
        assert_eq!(joins, [Join::Exact, Join::Contained, Join::Exact, Join::Exact]);
    }

    #[test]
    fn a_decorated_typescript_class_joins_the_space_after_its_decorator() {
        // Exported, the decorator belongs to tree-sitter's `export_statement`
        // and the class space starts a line later; the compiler starts the
        // class at its decorator — here the file's own span.
        let code = "\
@D()
export class R {
  m(): number {
    return 1;
  }
}
";
        let targets = [
            target(0, Category::Unit, 1, 6, 0),
            target(1, Category::Type, 1, 6, 1),
            target(2, Category::Invocable, 3, 5, 2),
        ];
        let measured = measure_file(LANG::Typescript, code.as_bytes(), &targets).unwrap();
        let joins: Vec<Join> = (0..3).map(|e| outcome(&measured, e).join).collect();
        assert_eq!(joins, [Join::Exact, Join::Leading, Join::Exact]);
    }

    #[test]
    fn a_leading_gap_holds_annotations_over_several_lines_and_nothing_else() {
        assert!(is_leading_gap(&[
            "@Entity",
            "@Table(name = \"T\",",
            "    schema = \"s)\")",
            "// note",
            ""
        ]));
        assert!(is_leading_gap(&["[Obsolete]", "/** doc */"]));
        assert!(
            !is_leading_gap(&["@A", "public @ResponseBody"]),
            "a modifier line is code"
        );
        assert!(!is_leading_gap(&["@A(value = 1,"]), "an annotation still open");
        assert!(!is_leading_gap(&["class Outer {"]));
    }
}
