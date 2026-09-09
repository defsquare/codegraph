---
title: Colour a Spring codebase by role
linkTitle: Spring roles
weight: 7
---

Spring's structure lives in annotations, not in the call graph: a controller
depends on a service it never constructs, and the container does the wiring at
runtime. Codegraph can read those annotations and say what it inferred — clearly
marked as an inference.

**Before you start:** a `model.jsonl` of a Spring codebase. The Spring
framework jars do **not** need to be present; matching tolerates the annotation
types being stubs, which is the normal case.

## Colour the city by role

```bash
codegraph serve model.jsonl --framework spring
```

`--framework spring` classifies types by Spring's own vocabulary (service,
repository, controller…), attaches a `role` to each building and adds a `roles`
legend block to the artifact. In the viewer this becomes a **Role** colour mode,
legended like every other channel. Without the flag the city says nothing about
roles at all.

The command tells you what the inference found, on `stderr`:

```text
note: spring classified 0 buildings into no role — an inference from written annotations, not a fact about the code.
```

Zero is the honest answer on a corpus with no Spring annotations. If you get it
on a codebase that has them, the model was extracted from a source root that
does not contain the annotated classes.

## Inspect the wiring

```bash
codegraph analyze model.jsonl --report wiring
```

The report is Spring's; there is no framework flag on `analyze`. It prints its
own disclaimer first, and it means it:

```text
framework: spring — every line below is DERIVED from annotations,
           never a declared fact; candidate targets are `dynamic-candidate`.

architectural roles (0 types):

entry points: 0 (called from outside the corpus)

injection points: 0

derived 0 candidate edge(s); 0 injection point(s) have no corpus implementation, 0 narrowed by @Primary/@Qualifier, 0 with an unresolved type.
```

Add `--json` for the same information under the standard report envelope.

## What is inferred, and how far to trust it

For every injection point — an annotated field, a constructor parameter on a
stereotyped class, or the sole constructor of one — the pass derives a
`dynamic-candidate` edge to **every corpus implementation** of the declared
interface. Then:

- `@Primary` narrows by its presence on the producer;
- `@Qualifier` narrows on its written argument value against the bean's names —
  exact strings, never guesswork;
- narrowing is never silent: the injection point says what it narrowed *from*.

**An empty candidate list is a result, not a gap.** On spring-petclinic at
`a6e81a5`, the recorded verification found all 6 `@Autowired` sites as 9
injection points: the 5 injecting `ClinicService` list exactly
`ClinicServiceImpl`, the corpus's one implementation, and the 4 injecting Spring
Data repository interfaces list nothing — because the container implements those
at runtime, so the empty set is a fact about the corpus. On petclinic `HEAD`,
which has no `@Autowired` at all, the profile's sole-constructor rule finds 6
injection points.

{{< callout type="warning" >}}
Nothing here is written back into the model. The `declared` view of a corpus is
byte-identical whether or not the wiring pass ran — verified as a test, not
claimed. Every derived candidate is `dynamic-candidate`, so
`--declared-only` removes all of it.
{{< /callout >}}

## Feed the roles to something else

```bash
codegraph domain-facts model.jsonl --framework spring --out dossiers.json
codegraph explain model.jsonl --src src/main/java --framework spring --dry-run
```

`domain-facts` adds stereotypes, entry points and DI candidates to each type's
dossier; `explain` adds them to the facts a prompt sees. Both label the layer as
an inference.

## Related

- [Facts and inferences never mix](/docs/explanation/facts-vs-inferences/)
- [`codegraph analyze`](/docs/reference/cli/analyze/)
- [`codegraph serve`](/docs/reference/cli/serve/)
- [`codegraph city`](/docs/reference/cli/city/)
- [Provenance reference](/docs/reference/metamodel/provenance/)
