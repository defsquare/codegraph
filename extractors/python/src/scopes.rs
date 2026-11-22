//! The binding rules (PLAN.md §23.4): the scope a name read in a scope finds,
//! as the compiler decides it — the scope itself, then the enclosing FUNCTION
//! scopes, lambdas and comprehensions included (never a class body), then the module; `global` sends a name to the
//! module and `nonlocal` past its own scope. `builtins` comes after all of
//! them, and is the resolver's.

use crate::declarations::{Binding, FileDecls, ScopeKind};

/// The bindings of `name` in the first scope that binds it, in source order;
/// empty when no scope of the file does.
pub fn lookup<'a>(decls: &'a FileDecls, scope: usize, name: &str) -> Vec<&'a Binding> {
    let declares = |list: &[String]| list.iter().any(|declared| declared == name);
    let mut current = Some(scope);
    let mut own = true;
    while let Some(index) = current {
        let here = &decls.scopes[index];
        if here.kind == ScopeKind::Module {
            return bound_in(decls, index, name);
        }
        // The scope the name is read in, whatever it is; above it, functions only.
        let encloses = matches!(
            here.kind,
            ScopeKind::Function(_) | ScopeKind::Lambda | ScopeKind::Comprehension
        );
        if own || encloses {
            if declares(&here.globals) {
                return bound_in(decls, 0, name);
            }
            if !declares(&here.nonlocals) {
                let found = bound_in(decls, index, name);
                if !found.is_empty() {
                    return found;
                }
            }
        }
        own = false;
        current = here.parent;
    }
    Vec::new()
}

/// Every binding of `name` in one scope, in source order.
pub fn bound_in<'a>(decls: &'a FileDecls, scope: usize, name: &str) -> Vec<&'a Binding> {
    decls.scopes[scope]
        .bindings
        .iter()
        .filter(|binding| binding.name == name)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus;
    use crate::declarations::{Bound, declarations};

    fn read(source: &str) -> FileDecls {
        declarations(source, &corpus::line_starts(source))
    }

    fn found(decls: &FileDecls, scope: usize, name: &str) -> Vec<(Bound, u32)> {
        lookup(decls, scope, name)
            .into_iter()
            .map(|binding| (binding.bound, binding.line))
            .collect()
    }

    #[test]
    fn a_class_body_is_seen_by_its_own_statements_and_by_no_function_inside_it() {
        // scopes: 0 module, 1 Mixin's body, 2 Outer's, 3 Outer.Mixin's, 4 Inner's, 5 method's, 6 Late's
        let decls = read(
            "class Mixin: pass\n\
             class Outer:\n    class Mixin: pass\n    class Inner(Mixin): pass\n    def method(self):\n        class Late(Mixin): pass\n",
        );
        // In Outer's body, `Mixin` is Outer's own.
        assert_eq!(found(&decls, 2, "Mixin"), vec![(Bound::Class(2), 3)]);
        // In a method of Outer, the class body is not enclosing: the module's.
        assert_eq!(found(&decls, 5, "Mixin"), vec![(Bound::Class(0), 1)]);
        assert_eq!(found(&decls, 0, "Nothing"), vec![]);
    }

    #[test]
    fn a_lambda_and_a_comprehension_enclose_like_a_function_and_a_walrus_binds_outside_them() {
        let decls = read(
            "def f(items):\n    total = 0\n    g = lambda x: [x + total for y in items if (last := y)]\n\
             class C:\n    k = 1\n    vals = [k for _ in range(3)]\n",
        );
        let first = |kind: ScopeKind| decls.scopes.iter().position(|scope| scope.kind == kind).unwrap();
        let (lambda, comprehension) = (first(ScopeKind::Lambda), first(ScopeKind::Comprehension));
        let function = decls
            .scopes
            .iter()
            .position(|s| s.kind == ScopeKind::Function(0))
            .unwrap();
        // The comprehension sees its own target, the lambda's parameter, and the function's locals…
        assert_eq!(found(&decls, comprehension, "y").len(), 1);
        assert_eq!(found(&decls, comprehension, "x"), vec![(Bound::Value, 3)]);
        assert_eq!(found(&decls, comprehension, "total"), vec![(Bound::Assigned(0), 2)]);
        assert_eq!(found(&decls, lambda, "total"), vec![(Bound::Assigned(0), 2)]);
        // …and `last :=` binds in the scope that contains the comprehension — here the lambda.
        assert!(bound_in(&decls, comprehension, "last").is_empty());
        assert_eq!(bound_in(&decls, lambda, "last").len(), 1);
        assert!(bound_in(&decls, function, "last").is_empty());
        // A comprehension in a class body does not see the class's names (beyond its first iterable).
        let in_class = decls
            .scopes
            .iter()
            .rposition(|scope| scope.kind == ScopeKind::Comprehension)
            .unwrap();
        assert_eq!(found(&decls, in_class, "k"), vec![]);
    }

    #[test]
    fn a_function_encloses_what_is_written_in_it_and_global_and_nonlocal_redirect() {
        // scopes: 0 module, 1 make's, 2 Base's (local), 3 Local's, 4 g's, 5 h's
        let decls = read(
            "Base = None\nvalue = 1\n\
             def make():\n    class Base: pass\n    class Local(Base): pass\n    global value\n    value = 2\n\
             \x20   def g():\n        Base = 3\n        def h():\n            nonlocal Base\n",
        );
        // A class in a function sees the function's locals…
        assert_eq!(found(&decls, 3, "Base"), vec![(Bound::Class(0), 4)]);
        // …a `global` name is the module's, whatever the function assigns…
        assert_eq!(found(&decls, 1, "value"), vec![(Bound::Assigned(1), 2)]);
        // …and `nonlocal` skips the scope that says it.
        assert_eq!(found(&decls, 5, "Base"), vec![(Bound::Assigned(3), 9)]);
        // Every binding of the scope that binds it, in source order.
        let twice = read("try:\n    from x import Y\nexcept ImportError:\n    Y = None\n");
        assert_eq!(
            found(&twice, 0, "Y"),
            vec![(Bound::Import { import: 0, alias: 0 }, 2), (Bound::Assigned(0), 4)]
        );
    }
}
