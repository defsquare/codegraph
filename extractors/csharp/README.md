# codegraph-csharp — Roslyn extractor

Reads a C# corpus (including legacy that does not build) and emits a
`model.jsonl` conforming to [`schemas/`](../../schemas/README.md) — the
per-record JSON Schemas and the container contract.

That contract is the **whole** of what this extractor knows about the
metamodel: the C# id scheme, the kind → traits table (PLAN.md §13.2), and how
to write bytes. Traits, profiles and validation live once, in
`@codegraph/core`; the cross-language gate is
`packages/core/test/fixtures-csharp.test.ts`.

## Build

```bash
# user-local SDK, sdkman-style — non-interactive shells cannot see a login-shell PATH
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir ~/.dotnet
export DOTNET_ROOT="$HOME/.dotnet"; export PATH="$DOTNET_ROOT:$PATH"

cd extractors/csharp
dotnet test -c Release                       # 51 tests, incl. schema validation of the output
dotnet build src/Codegraph.CSharp -c Release # dev build: src/Codegraph.CSharp/bin/Release/net10.0/codegraph-csharp

# or, from the repo root, with the toolchain checks:
./build.sh --csharp                          # publishes the HOST binary to extractors/csharp/dist/<rid>/
./build.sh --csharp --publish-all            # linux-x64, linux-arm64, osx-x64, osx-arm64, win-x64
./test.sh --csharp                           # dotnet test + the published binary reproduces the snapshot
```

`global.json` pins the SDK band (10.0, LTS). `Directory.Build.props` holds the
knobs that matter across operating systems: `InvariantGlobalization` (no
`libicu` needed on minimal Linux, ordinal strings everywhere), deterministic
builds, warnings as errors, and the one extractor version the assembly,
`--version` and the model header all report.

### Why the binary is self-contained, and how the BCL travels inside it

The extractor never reads a `.sln` or `.csproj` and never calls
`MSBuildWorkspace`: every `*.cs` under the roots (`bin/` and `obj/` excluded)
is parsed into **one** compilation, bound against the BCL reference
assemblies. Those are the SDK's own `Microsoft.NETCore.App.Ref` pack,
**embedded as resources** at build time and loaded as metadata images.

The tutorial way — `MetadataReference.CreateFromFile(typeof(object).Assembly.Location)`
— works under `dotnet run` and silently binds *nothing* inside a single-file
bundle, where `Assembly.Location` is the empty string: every `string` would
become an unresolved stub, and the failure would show only as a resolution rate
on a user's machine. The csproj fails the build when the pack glob is empty,
`ReferenceAssembliesTest` pins that `string` lands in module `System`, and
`test.sh` runs the **published** artifact against the fixture, because that is
the only test that walks the single-file code path.

Publish shape (what `build.sh` runs): self-contained, single file, compressed,
ReadyToRun, **not trimmed** — Roslyn is not trim-clean. NativeAOT is deferred
for the same reason, and because it would need each target OS's native
toolchain; single-file cross-publishes every RID from one Linux host.

## Run

```bash
codegraph-csharp --src src --out model.jsonl

# both options default: extract the current directory into <current-dir>-codegraph.jsonl
codegraph-csharp
```

| Option | Meaning |
|---|---|
| `--src <dir>` | source root to analyze. Repeatable; defaults to the current directory. With several roots, anchors are relativized against their deepest common ancestor, which becomes the model's `root`. |
| `--out <file>` | where to write the model. Defaults to `<current-dir>-codegraph.jsonl`. |
| `--progress <mode>` | `auto` (default: one line per phase when stderr is a terminal, nothing when piped), `plain` or `none` |
| `--no-progress` | same as `--progress none` |
| `--repo-remote`, `--repo-commit`, `--repo-root`, `--repo-provider` | repository facts copied verbatim into the header (`codegraph snapshots` passes them) |
| `--version`, `--help` | |

Exit codes: `0` success, `1` failure, `2` bad usage, `3` an extraction pass
not implemented yet. This is the extractor command-line contract
(`schemas/README.md §8`), shared with the Java jar so
`codegraph snapshots --extractor` can drive either.

Two runs over the same corpus produce **byte-identical** output, on every OS:
files are walked in ordinal order, paths are `/`-separated, entities are sorted
by natural key (UTF-16 code units), and the JSON writer reproduces
`JSON.stringify` exactly — the fixture gate in core compares the two encoders'
bytes.

## The stderr summary

```
RESOLUTION SUMMARY
  type references : 9
  resolved        : 7
  unresolved      : 2
  resolution rate : 77.8%
  imports         : 15 (unresolved: 2, without a module: 0)
  entities        : 42 (stubs: 11)
  edges           : 24 (self-edges dropped: 0, dynamic call sites dropped: 0)
```

- **type references / resolved / unresolved** — how many type references in
  the walked positions bound to a symbol Roslyn could name. A reference to a
  package that is not under the roots cannot be resolved by any extractor: the
  rate measures the corpus's dependency surface, and the graph is a lower
  bound, not a wrong answer.
- **imports** — `using` directives folded to module-level import edges; an
  unresolved one still yields a stub namespace named as written; one in a file
  that declares no corpus type has no module to hang on and is dropped, counted.
- **entities (stubs)** — a stub is a type or namespace referenced but declared
  outside the roots. A metadata type (the BCL) is a stub in its **real**
  namespace with its real kind; a name Roslyn could not bind is a stub in the
  reserved module `<unresolved>`, named as written — never a namespace guessed
  from the file's `using` directives.
- **self-edges dropped** — `from == to` is not representable (METAMODEL §4);
  `using Acme;` inside `namespace Acme` is the common case.

## What is extracted (M12b)

**Entities.** Namespaces (modules; a nested block declaration gets a lexical
parent); every type kind (class, interface, struct, enum with its underlying
type, record, delegate); methods, constructors (the implicit parameterless one
included, anchored at the type's header line, so `new Basket()` does not
dangle; a record's primary constructor anchored at its parameter list),
operators (`op_Addition`), conversions, finalizers (`Finalize`), properties and
indexers (`Item(System.Int32)`), fields, `const` and enum members with their
constant as `TWithValue`, events, parameters with their written defaults,
locals, lambdas and anonymous methods (`Type#file:line:column`), local
functions (`Method(…)#fn:Name(…)`). XML doc comments as `TComment`; `sloc` and
`cyclomatic` as `TMetrics` on every type and invocable.

**Not entities, on purpose.** Members Roslyn synthesizes and nobody wrote — a
record's `Equals`/`GetHashCode`/`Deconstruct`/copy constructor, backing fields,
an enum's `value__` — and accessors, whose bodies charge to their property.
A call to such a member folds to its containing type: `money == other` is a
dependency on `Money`.

**Edges.** `import` (every `using` form, folded to a namespace), `inheritance`,
`interfaceImplementation`, `invocation` (methods, constructors, `: this()` /
`: base()`, user-defined operators, delegate invocations folded to the delegate
type, extension methods resolved to the static method), `access` (fields,
properties, events, indexers, with `isRead`/`isWrite`; `+=`, `++` and `ref`
are both), `reference` (every written type usage, from the narrowest declared
owner — a parameter's type comes from the parameter; a method group used as a
value is a reference to the method), `throws` (per `throw` statement, a
rethrow resolving to the catch's type), `annotationUse` (attributes, with
positional arguments named after the bound constructor's parameters and values
as written: constants folded, enum members by name, `typeof` as a type, arrays
as arrays, anything else `unevaluated`).

**Ids of locals carry line AND column** (`#local:name:line:column`) — two
declarations of one name on one line are legal (`for … for …`), and a column is
a source fact where an ordinal would depend on walk order.

**Dropped and counted.** A `dynamic` call site (no symbol to bind), a `using`
in a file declaring no corpus module, a self-edge (`using Acme;` inside
`namespace Acme`), and an attribute on the assembly (nothing declared to hang
it on).

## Fixture and snapshot

`fixtures/csharp/src` is the reference corpus (`Acme.Order`, the Java fixture's
twin plus what C# adds: partial types, a nested block namespace, `Repository`
beside `Repository<T>`, a delegate, non-ASCII identifiers, unresolvable
externals). `SnapshotTest` reproduces `fixtures/csharp/expected/model.jsonl`;
`CODEGRAPH_UPDATE_SNAPSHOT=1 dotnet test` regenerates it deliberately, and the
diff is reviewed like any other change.

The committed snapshot is also the cross-OS check where CI has no runner:
download a published binary, run it on the fixture, `cmp` against the snapshot.

## OS notes

- **macOS**: unsigned binaries are quarantined on download —
  `xattr -d com.apple.quarantine codegraph-csharp && chmod +x codegraph-csharp`.
- **Windows**: `codegraph-csharp.exe`; SmartScreen warns once. Source files with
  `\r\n` give the same lines and bytes as `\n` ones (pinned by `DeterminismTest`).
- **Linux**: no `libicu` required (invariant globalization).
