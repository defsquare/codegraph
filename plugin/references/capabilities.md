# What codegraph gives, per language

GENERATED — do not edit. Rendered from the language profiles (`codegraph
profiles`), the framework profiles and the extractor catalogue, by
`CODEGRAPH_UPDATE_SNAPSHOTS=1 pnpm --filter @codegraph/cli test plugin-capabilities`.

Read the column of the language at hand before a step, and say what is
missing BEFORE the person finds out. A language that is not in the first
table has no extractor: its files are counted at preflight, and nothing more
can be said about them.

## Extractors

| Language | `lang` | Files | Extractor | Install |
|---|---|---|---|---|
| Java | `java` | `.java` | `codegraph-java` | `brew install defsquare/tap/codegraph-java` |
| C# | `csharp` | `.cs` | `codegraph-csharp` | `brew install defsquare/tap/codegraph-csharp` |
| TypeScript | `ts` | `.ts`, `.tsx` | `codegraph-typescript` | `brew install defsquare/tap/codegraph-typescript` |
| Elixir | `ex` | `.ex`, `.exs` | `codegraph-elixir` | `brew install defsquare/tap/codegraph-elixir` |
| Ruby | `rb` | `.rb`, `.rake`, `.gemspec`, `.ru` | `codegraph-ruby` | `brew install defsquare/tap/codegraph-ruby` |
| Python | `python` | `.py`, `.pyw`, `.pyi` | `codegraph-python` | `brew install defsquare/tap/codegraph-python` |

Every extractor takes the same flags: `--src DIR`, repeatable, and `--out FILE`.
It reads sources and runs nothing of the project.

The metrics pass, `codegraph-metrics`, runs after any of them and adds measures to
the model it is given (`brew install defsquare/tap/codegraph-metrics`).

## What a model holds

| | Java | C# | TypeScript | Elixir | Ruby | Python |
|---|---|---|---|---|---|---|
| A module is a | `package` | `namespace` | `module` | `file` | `file` | `module` |
| A type is a | `class`, `interface`, `enum`, `record`, `annotation` | `class`, `interface`, `struct`, `enum`, `record`, `delegate` | `class`, `abstractClass`, `interface`, `typeAlias`, `enum` | `module`, `protocol` | `class`, `module` | `class` |
| An operation is a | `method`, `constructor`, `lambda` | `delegate`, `method`, `constructor`, `lambda` | `function`, `method`, `constructor`, `arrowFunction` | `function`, `macro`, `callback` | `method` | `function`, `method` |
| Kinds that may carry measures | `class`, `interface`, `enum`, `record`, `annotation`, `method`, `constructor`, `lambda` | `class`, `interface`, `struct`, `enum`, `record`, `delegate`, `method`, `constructor`, `property`, `lambda` | `module`, `namespace`, `class`, `abstractClass`, `interface`, `typeAlias`, `enum`, `function`, `method`, `constructor`, `arrowFunction` | `file`, `module`, `protocol`, `function`, `macro` | `file`, `class`, `module`, `method` | `module`, `class`, `function`, `method` |
| Edge kinds | `import`, `inheritance`, `interfaceImplementation`, `invocation`, `access`, `reference`, `annotationUse`, `throws` | `import`, `inheritance`, `interfaceImplementation`, `invocation`, `access`, `reference`, `annotationUse`, `throws` | `import`, `inheritance`, `interfaceImplementation`, `invocation`, `access`, `reference`, `annotationUse`, `throws` | `import`, `interfaceImplementation`, `invocation`, `access`, `reference`, `throws` | `import`, `inheritance`, `traitUsage`, `invocation`, `access`, `reference`, `throws` | `import`, `inheritance`, `interfaceImplementation`, `invocation`, `access`, `reference`, `annotationUse`, `throws` |
| Annotations as edges (`annotationUse`) | yes | yes | yes | no | no | yes |
| Inheritance as an edge | yes | yes | yes | no | yes | yes |
| Takes a trace of the compiler or the runtime (`--trace`) | no | no | no | yes | yes | yes |
| External code is filed under | one module per external package | one module per external namespace, `<unresolved>` | one module per external package or library, `<lib>`, `<unresolved>` | `<deps>`, `<otp>` | one module per external package or library, `<gems>`, `<ruby>` | one module per external package or library, `<builtins>`, `<site>`, `<stdlib>` |

How to read it:

- **A module.** Where the module kind is `file` or `module`, a module is one
  source file: "size per module" is size per file, and the module graph is a
  graph of files. Where it is `package` or `namespace`, it groups files.
- **A type** is asked for by its trait, `TType`, never by a list of kinds: the
  shipped queries do, and so must any query you write.
- **Measures.** A kind that is not in the measures row has no size and no
  complexity. A query over measures skips it: absent is not zero.
- **No `annotationUse`:** no annotation census in step 2, and no entry point
  found by annotation in step 4.
- **External code.** Step 2 reads the technology stack from the modules the
  code references and does not declare. A name in angle brackets is a root that
  gathers many libraries. Where the row lists roots only, that table says how
  much the code leans on each side and no more: the bill of materials is then
  the build file, which you read and never run.
- **A trace** adds `generated` edges: what a macro, a `use` or a runtime hook
  wires. Without one those edges are not in the model. Producing a trace runs
  the project's own code: it is the person's to run, never yours.

## Framework profiles

| Framework | `--framework` | Language | Annotations | Roles it assigns |
|---|---|---|---|---|
| Spring | `spring` | Java | 28 | `stereotype`, `injection-point`, `entry-point`, `qualifier`, `primary` |

No other framework has a profile. For any other, `analyze --report wiring` and
`--framework` have nothing to say; a step then says "no profile for this
framework", never "there is none".
