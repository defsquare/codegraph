# Running the TypeScript extractor

`codegraph-typescript` reads a TypeScript source tree — one that no longer
builds, has no `node_modules`, or is a `namespace`-and-`/// <reference>`
codebase from before ES modules — and writes a `model.jsonl` the rest of
codegraph consumes. It is the TypeScript compiler used as a library: the
same `typescript` package that ships `tsc`, whose checker binds everything it
can and tolerates everything it cannot. Nothing is built, no `tsc` is run,
and a package that is not installed is a stub, not a failure.

There are two ways to run it. They produce the same bytes for the same corpus.

| You have | Run it as |
|---|---|
| a clone of this repository, built (`pnpm -r build`) | `./bin/codegraph-typescript` |
| **Node 22** and nothing else | `npx codegraph-typescript` (once published; the GitHub release is the release, npm the convenience) |

Both take the same options and exit codes (§3), so a script written against
one keeps working against the other.

## 1. From a clone

```bash
pnpm install && pnpm -r build
./bin/codegraph-typescript --src path/to/src --out model.jsonl

# codegraph on itself: the workspace's packages, by name, with nothing built
./bin/codegraph-typescript --src packages --src extractors/typescript --out codegraph.jsonl
```

The launcher runs the bundle at `extractors/typescript/dist/cli.js`. The
bundle leaves `typescript` outside itself on purpose: the compiler locates
its `lib.*.d.ts` files beside its own `typescript.js`, so a bundle that
inlined it would bind no standard library and every `Array` would become an
`<unresolved>` stub — while every test run from sources passed. `test.sh
--ts` runs the built bundle over the fixture corpus and compares the bytes.

## 2. What it reads, and how it resolves without a build

- **Every `*.ts`, `*.tsx`, `*.mts`, `*.cts` under the roots** goes into ONE
  program (`*.js` and friends too with `--allow-js`). `node_modules`, `.git`
  and `dist` are skipped: dependencies and build output are never sources.
  Point `--src` at a source tree, not at one package: one run over a
  monorepo covers every package in it, and the model's modules are its files.
- **A `tsconfig.json` is read for its RESOLUTION options only** — `paths`,
  `baseUrl`, `rootDirs`, `jsx`, `lib`, `target`, `allowJs`, decorators, module
  suffixes — never for `files`/`include` (the roots define the corpus) and
  never for project `references`. The nearest `tsconfig.json` at or above each
  root applies; with several roots the first root's wins and the others are
  named on stderr. `--tsconfig FILE` overrides; `--tsconfig none` uses the
  synthesized defaults (`target esnext`, `moduleResolution bundler`, `lib
  esnext + dom`, `jsx preserve`).
- **A monorepo's own packages resolve by name with nothing installed.** A
  bare specifier that names a `package.json` under the roots (`@acme/pricing`)
  resolves to that package's SOURCE entry — the `source`/`types`/`main` field
  when it points at a file under the roots, else `src/index.ts` — and only
  after standard resolution failed, or landed in the package's own `dist/`
  through a workspace symlink. These are counted separately on stderr
  (`workspace-resolved`). It never reads `node_modules` to do so.
- **Installed packages are external.** A type declared under
  `node_modules/<pkg>` is a stub in the module named by the package
  (`zod/ZodType`), never by the resolved `.d.ts` path, so keys are the same on
  every machine; an import of `zod/v4` is a stub module keyed by the specifier
  as written. `--ignore-node-modules` makes the install invisible: every
  external package becomes an unresolved stub module and every call into it is
  dropped and counted. The fixture snapshot is produced that way in spirit —
  its `tsconfig.json` sets `"types": []` so the repository's own `@types` never
  leak into it.
- **The standard library resolves and is still external**: `Array`,
  `Promise`, `Error` are stubs in the reserved module `<lib>`. A name the
  checker cannot bind is a stub in `<unresolved>`, named as written — never a
  guess from the file's imports. A module specifier that resolves to nothing
  becomes a stub module keyed by the specifier, so the import edge survives.

## 3. Options and exit codes

The extractor command-line contract in [`schemas/README.md` §8](../schemas/README.md),
shared with the Java jar and the C# binary, plus three flags of its own:

```
codegraph-typescript [--src <dir>]… [--out <file>] [--progress auto|plain|none] [--no-progress]
                     [--tsconfig <file>|none] [--allow-js] [--ignore-node-modules]
                     [--repo-remote <url>] [--repo-commit <sha>] [--repo-root <path>] [--repo-provider <p>]
                     [--version] [--help]
```

| Option | Meaning |
|---|---|
| `--src <dir>` | source root; repeatable; default the current directory. With several roots, anchors are relative to their deepest common ancestor, which becomes the model's root. |
| `--out <file>` | where to write; default `<current-dir>-codegraph.jsonl` |
| `--progress` | `auto` (one line per phase when stderr is a terminal, nothing when piped), `plain`, `none` |
| `--tsconfig <file>` | the tsconfig whose resolution options apply; `none` for the defaults |
| `--allow-js` | also walk JavaScript files; JSDoc types feed `declaredType`; the model still claims `lang: "ts"` |
| `--ignore-node-modules` | never read `node_modules`, even when present |
| `--repo-remote`, `--repo-commit`, `--repo-root`, `--repo-provider` | repository facts copied verbatim into the header, so the city and navigator can link a building to its line on the host. `codegraph snapshots` passes them. |

Exit codes: `0` success · `1` failure · `2` bad usage · `3` an extraction
pass not implemented yet. `stdout` carries nothing but `--help`/`--version`;
progress and the summary go to `stderr`.

## 4. Reading the summary

```
✓ program    310 files, tsconfig none  2.4s
✓ entities   24887 entities  1.1s
✓ edges      51255 edges  1.8s
✓ stubs      411 stubs  0.1s
✓ write      76464 records  0.4s
RESOLUTION SUMMARY
  type references : 4500
  resolved        : 4340
  unresolved      : 160
  resolution rate : 96.5%
  any-typed receivers (dropped) : 193
  imports         : 1607 (unresolved: 2, workspace-resolved: 168)
  entities        : 24887 (stubs: 411 — lib 55, packages 300, <unresolved> 0, modules 56)
  edges           : 51255 (self-edges dropped: 89, indirect calls dropped: 143, computed accesses dropped: 607, …)
  duplicates      : 0 same-keyed declarations re-keyed (first in file order keeps the plain key)
  unclosable      : 0 edges dropped (an endpoint no entity declares)
wrote codegraph.jsonl
```

That is codegraph over itself. What each line says:

- **resolution rate** measures the corpus's *dependency surface*, not the
  extractor: a package that is not under the roots cannot be resolved by any
  tool. The 160 unresolved type references above are type-space names the
  corpus uses and the checker could not name — every one an external type or
  a type parameter the model does not reify — and `<unresolved> 0` says no
  name the corpus DECLARES was missed.
- **any-typed receivers** is this profile's stated ceiling: a call or member
  access through an `any`/`unknown`/error-typed receiver has no target and is
  dropped, never guessed. The proportion is a fact about the corpus's typing.
- **indirect calls** are calls through a parameter or local of function type
  (`callback()`): no declaration to name statically.
- **computed accesses** are `obj[key]` with a non-literal key.
- **workspace-resolved** imports are the monorepo's own packages, reached by
  `package.json` name without an install (§2).
- **stubs** by origin: the compiler's lib, installed packages, unbound names,
  and stub modules (unresolved or external specifiers).
- **duplicates** are same-keyed declarations in one file the language does not
  merge — the later one re-keyed by its position and named on stderr.
- **unclosable** edges point at an entity nothing declares; they are dropped,
  never written dangling. Zero on every audited corpus; a non-zero count is a
  bug report against the id scheme.

Measured on three corpora with no `node_modules` (PLAN.md §14.9): TypeScript
4.9's compiler 97.4 % (2 684 any-typed receivers), nestjs 88.6 % (20 745),
excalidraw 94.4 % (24 954). Those any-receiver counts are what an uninstalled
dependency surface costs: install the dependencies to fold the calls into
their packages' stubs instead.

## 5. What the model says (and what it does not)

The full rules live in the profile's `notes`
(`packages/core/src/profiles/typescript.ts`) and in `PLAN.md` §14. The short form:

- **The module is the file.** Keys are root-relative paths with `/`, `#`
  and `%` percent-encoded (`packages%2Forder%2Fsrc%2Forder.ts`); the module's
  `name` is the path as written. A script file's globals are children of the
  file; a `namespace` is a child entity; `declare module "x"` in a corpus
  `.d.ts` IS the module `x`.
- **Declaration merging is one entity per declaring file**, the strongest
  kind owning the key (class > enum > function > variable > interface >
  alias > namespace). A reference to a merged symbol lands on the
  declaration that owns the member.
- **Members**: overloads are one entity; `#static` only beside an instance
  twin; `#get`/`#set` only for a written pair; nameless invocables by
  `line:column`; locals by `#local:name:line:column`; a parameter property is
  a field. Members of an anonymous type literal or of an unbound object
  literal are not entities.
- **Spaces**: interfaces, aliases, const enums and interface members are
  type-space; a dependency on them is erased at runtime. The model keeps
  them; a runtime analysis filters on the target's `space`.
- **Edges** are all `declared`: calls (through a variable to its arrow, `new`
  to the written constructor or the class, JSX elements to their component),
  accesses with read/write flags (a write lands on a setter), references from
  the narrowest owner, decorators as `annotationUse` with named arguments,
  throw sites. Structural conformance is never inferred here.
- **Values** ride only for constant-shaped initializers; TypeScript folds
  nothing, so `4 * 25` is `unevaluated`. An initializer that is code carries
  no value and owns its edges.
- **Measures**: `sloc` and `cyclomatic`, on the compiler's own tokens.

## 6. Feeding the result to codegraph

```bash
./bin/codegraph validate model.jsonl                 # closure, provenance, profile, anchors
./bin/codegraph analyze  model.jsonl --report deps   # module/type dependency graph
./bin/codegraph serve    model.jsonl                 # navigator + 3D city at http://localhost:4177
./bin/codegraph explain  model.jsonl --src path/to/src --dry-run

# extract a repository at every tag into a temporal store:
./bin/codegraph snapshots path/to/repo --extractor bin/codegraph-typescript --tags --src src
```

`snapshots` runs the extractor as a process once per revision; a `.js` runs
under `node`, a `.jar` under `java -jar`, anything else directly.

## 7. Same bytes everywhere

Two runs over one unchanged corpus produce byte-identical files, on every OS:
files are walked in code-unit order, paths are written with `/`, entities are
sorted by natural key, comments have their line endings normalised, and the
JSON is `JSON.stringify` itself. CI runs the built bundle on Ubuntu, macOS and
Windows and `cmp`s the output with the committed snapshot. Checkable in one
line, from the repository root with that relative `--src` (the typed path is
the header's `root`):

```bash
./bin/codegraph-typescript --src fixtures/typescript/src --out /tmp/m.jsonl --progress none \
  && cmp /tmp/m.jsonl fixtures/typescript/expected/model.jsonl && echo same
```

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| every `Array`, `Promise`, `Error` shows up under `<unresolved>` | the compiler cannot find its `lib.*.d.ts`: a hand-bundled build inlined `typescript` | run the built bundle from a workspace install, or `npx codegraph-typescript`; never inline the compiler |
| a monorepo package's types land in `<unresolved>` | its `package.json` has no `name`, or its entry is not under the roots | add the package's root to `--src`, or a `source` field pointing at its `.ts` entry |
| `tsconfig not applied (another root's won)` on stderr | two roots with their own `tsconfig.json` | `--tsconfig` the one whose `paths` matter, or run once per root |
| a `codegraph.jsonl` with far fewer modules than expected | `--src` pointed below the sources, or the sources are `.js` | add roots with repeated `--src`; `--allow-js` |
| the header's `root` is absolute | `--src` was typed absolute | type it relative to the directory you run from |
| `JavaScript heap out of memory` on a very large corpus | the checker holds every type of a single program | `NODE_OPTIONS=--max-old-space-size=8192`, or one run per package root |
