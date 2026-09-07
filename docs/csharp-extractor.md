# Running the C# extractor

`codegraph-csharp` reads a C# source tree — a legacy one that no longer
builds included — and writes a `model.jsonl` the rest of codegraph consumes.
It never opens a `.sln` or `.csproj`: every `*.cs` under the roots is parsed
into one compilation and bound against a copy of the .NET base class library
that travels inside the extractor. A missing NuGet package is a stub, not a
build failure.

There are three ways to run it. They produce the same bytes for the same
corpus; pick by what the machine has.

| You have | Run it as | What you need to install |
|---|---|---|
| nothing | the **self-contained binary** for your OS | nothing |
| the .NET **runtime** (no SDK) | `dotnet codegraph-csharp.dll` from a framework-dependent publish | .NET 10 runtime |
| the .NET **SDK** | `dotnet run` from source, or a dev build | .NET 10 SDK |

Every form takes the same options and exit codes (§3), so a script written
against one keeps working against another.

## 1. Self-contained binary (nothing to install)

One executable per OS and CPU, with the runtime, the compiler and the base
class library inside. About 64 MB. Built by `./build.sh --csharp` (the host's
platform) or `./build.sh --csharp --publish-all` (all five), into
`extractors/csharp/dist/<rid>/`:

| file | platform |
|---|---|
| `dist/linux-x64/codegraph-csharp` | Linux on x86-64 |
| `dist/linux-arm64/codegraph-csharp` | Linux on ARM (Graviton, Raspberry Pi, Docker on Apple silicon) |
| `dist/osx-arm64/codegraph-csharp` | macOS on Apple silicon |
| `dist/osx-x64/codegraph-csharp` | macOS on Intel |
| `dist/win-x64/codegraph-csharp.exe` | Windows on x86-64 |

```bash
# Linux / macOS
chmod +x codegraph-csharp
./codegraph-csharp --src path/to/src --out model.jsonl

# macOS only, once, for a binary that arrived by download: it is unsigned,
# and Gatekeeper quarantines it
xattr -d com.apple.quarantine codegraph-csharp

# Windows (SmartScreen warns once)
codegraph-csharp.exe --src path\to\src --out model.jsonl
```

No `libicu` is needed on Linux: the extractor is built with invariant
globalization, so it runs on a minimal container image.

## 2. With the .NET runtime only (`dotnet codegraph-csharp.dll`)

For a machine that has the .NET 10 **runtime** but not the SDK — a CI image
such as `mcr.microsoft.com/dotnet/runtime:10.0`, or a server that runs other
.NET apps. Someone with the SDK publishes a *framework-dependent* build once
(about 15 MB, no runtime inside):

```bash
cd extractors/csharp
dotnet publish src/Codegraph.CSharp -c Release -o /some/dir
```

Then, wherever the runtime is present:

```bash
dotnet /some/dir/codegraph-csharp.dll --src path/to/src --out model.jsonl
# or the small launcher next to it, which finds the runtime itself
/some/dir/codegraph-csharp --src path/to/src --out model.jsonl
```

The publish directory must be copied whole: the launcher, the `.dll`, its
`.deps.json` and `.runtimeconfig.json`, and the Roslyn assemblies beside it.
The base class library the extractor binds against is embedded in
`codegraph-csharp.dll`, so nothing else has to match the target machine.

Installing the runtime without the SDK:

```bash
# Linux / macOS, user-local (no root)
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --runtime dotnet --channel 10.0 --install-dir ~/.dotnet
export DOTNET_ROOT="$HOME/.dotnet"; export PATH="$DOTNET_ROOT:$PATH"

# Windows (PowerShell)
Invoke-WebRequest https://dot.net/v1/dotnet-install.ps1 -OutFile dotnet-install.ps1
.\dotnet-install.ps1 -Runtime dotnet -Channel 10.0
```

The extractor rolls forward to any newer major runtime (`RollForward=LatestMajor`),
so a machine with .NET 11 runs a build made for .NET 10.

## 3. With the .NET SDK (from source)

For development, or for a machine that has the SDK anyway. Install it
user-locally, sdkman-style — non-interactive shells cannot see a login
shell's PATH, which is why the scripts also look in `~/.dotnet`:

```bash
# Linux / macOS
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir ~/.dotnet
export DOTNET_ROOT="$HOME/.dotnet"; export PATH="$DOTNET_ROOT:$PATH"
# or: brew install --cask dotnet-sdk        (macOS)
#     apt install dotnet-sdk-10.0            (Ubuntu 24.04+, system-wide under /usr/lib/dotnet)

dotnet --version        # 10.0.x
```

Then either run straight from the sources (the first run restores packages
from NuGet and compiles; later runs are instant):

```bash
dotnet run --project extractors/csharp/src/Codegraph.CSharp -c Release -- --src path/to/src --out model.jsonl
```

or build once and run the executable from the build output:

```bash
cd extractors/csharp
dotnet build src/Codegraph.CSharp -c Release
src/Codegraph.CSharp/bin/Release/net10.0/codegraph-csharp --src path/to/src --out model.jsonl
```

`./build.sh --csharp` and `./test.sh --csharp` at the repository root wrap
the same commands with the toolchain checks (SDK band from `global.json`,
telemetry off) and, for `test.sh`, the 76-test suite plus the check that the
published binary reproduces the committed fixture snapshot byte for byte.

## 4. Options and exit codes

The same for every form — the extractor command-line contract in
[`schemas/README.md` §8](../schemas/README.md), shared with the Java jar:

```
codegraph-csharp [--src <dir>]… [--out <file>] [--progress auto|plain|none] [--no-progress]
                 [--repo-remote <url>] [--repo-commit <sha>] [--repo-root <path>] [--repo-provider <p>]
                 [--version] [--help]
```

| Option | Meaning |
|---|---|
| `--src <dir>` | source root; repeatable; default the current directory. With several roots, anchors are relative to their deepest common ancestor, which becomes the model's `root`. `bin/` and `obj/` are skipped: they hold build output, never sources. |
| `--out <file>` | where to write; default `<current-dir>-codegraph.jsonl` |
| `--progress` | `auto` (one line per phase when stderr is a terminal, nothing when piped), `plain`, `none` |
| `--repo-remote`, `--repo-commit`, `--repo-root`, `--repo-provider` | repository facts copied verbatim into the header, so the city and navigator can link a building to its line on the host. `codegraph snapshots` passes them. |
| `--implicit-usings <mode>` | the global usings a project with `ImplicitUsings` enabled gets from a generated file in `obj/` (build output, skipped). `sdk` (default): `System`, `System.Collections.Generic`, `System.IO`, `System.Linq`, `System.Net.Http`, `System.Threading`, `System.Threading.Tasks` — without them `Task` and `List<T>` in a file with no `using` of its own bind to nothing. `web`: adds the Web SDK's `Microsoft.AspNetCore.*` and `Microsoft.Extensions.*`, for a corpus that is all Web-SDK projects (on a mixed one they make names ambiguous: OrchardCore's own `StartupBase` collided with `Microsoft.AspNetCore.Hosting.StartupBase`). `none`: nothing added. They write no import edge. |

Exit codes: `0` success · `1` failure · `2` bad usage · `3` an extraction
pass not implemented yet. `stdout` carries nothing but `--help`/`--version`;
progress and the summary go to `stderr`.

Bare, it extracts the current directory:

```bash
cd my-solution && codegraph-csharp          # → my-solution-codegraph.jsonl
```

Point `--src` at the source tree, not at a single project: the extractor's
whole point is that it needs no project graph, so one run over a solution
folder covers every project in it, and the model's namespaces are the corpus's
own.

## 5. Reading the summary

```
✓ walk       20 files  0.0s
✓ parse      20 files  0.0s
✓ bind       166 reference assemblies  0.0s
✓ whitelist  26 types  0.1s
✓ entities   208 entities  0.2s
✓ edges      285 edges  0.0s
✓ stubs      36 stubs  0.0s
✓ write      551 records  0.0s
RESOLUTION SUMMARY
  type references : 285
  resolved        : 267
  unresolved      : 18
  resolution rate : 93.7%
  imports         : 15 (unresolved: 5, without a module: 0)
  entities        : 244 (stubs: 36)
  edges           : 285 (self-edges dropped: 1, dynamic call sites dropped: 1)
wrote model.jsonl
```

- **resolution rate** measures the corpus's *dependency surface*, not the
  extractor: a package that is not under the source roots cannot be resolved
  by any tool. A low rate says the corpus depends on a lot that is not there;
  the graph is a lower bound, not a wrong answer. Above, the 18 unresolved
  references are the fixture's deliberately absent `MegaCorp.Ledger` and
  `Newtonsoft.Json`.
- **stubs** are types and namespaces referenced but declared outside the
  roots. The base class library resolves (it is embedded) and still counts as
  external: `string` is a stub in namespace `System`. A name that binds to
  nothing is a stub in the reserved module `<unresolved>`, named as written —
  never a namespace guessed from the file's `using` directives.
- **dropped and counted**: a `dynamic` call site (no symbol to bind), a
  `using` in a file that declares no corpus type, and a self-edge (`using
  Acme;` inside `namespace Acme`).
- **duplicates** — a corpus is not one compilation unit. Two projects that
  never see each other may both declare `static class Extensions` with the
  same member, and every service has its own top-level `Program.cs`; the
  extractor keeps them all, the first in file order under the plain key and
  each later one re-keyed by its file (`…#in:Catalog.API/Program.cs`), and
  names every re-keying on stderr.

The base class library and the ASP.NET Core shared framework both resolve
(both reference packs travel inside the binary). What stays unresolved,
measured: third-party packages — on dotnet/eShop, EF Core and Npgsql
(`DbContext`, `DeleteBehavior`), .NET MAUI (`BindableProperty`, `Preferences`)
and CommunityToolkit.Mvvm (`RelayCommand`); on OrchardCore, Fluid
(`FluidValue`, `TemplateContext`), GraphQL (`FieldType`, `StringValue`) and
OpenIddict — plus generated code whose output is not under the roots (on
Humanizer, the source generators' `*RegistryRegistrations`), and one honest
limit of a single compilation: two corpus types with one simple name whose
projects each `global using` their own namespace (eShop's two `CatalogItem`)
are ambiguous once those usings merge, and an ambiguous name is unresolved.

## 6. Feeding the result to codegraph

```bash
./bin/codegraph validate model.jsonl                 # closure, provenance, profile, anchors
./bin/codegraph analyze  model.jsonl --report deps   # module/type dependency graph
./bin/codegraph city     model.jsonl --serve         # 3D city at http://localhost:4177
./bin/codegraph navigator model.jsonl --serve        # navigator at http://localhost:4178
./bin/codegraph explain  model.jsonl --src path/to/src --dry-run

# extract a repository at every tag into a temporal store, with any of the three forms:
./bin/codegraph snapshots path/to/repo --extractor /path/to/codegraph-csharp --tags --src src
```

`snapshots` runs the extractor as a process once per revision; a `.jar` runs
under `java -jar`, anything else directly, so a self-contained binary, the
framework-dependent launcher and the SDK build output all work there.

## 7. Same bytes everywhere

Two runs over one unchanged corpus produce byte-identical files, on every OS
and in every form above: files are walked in ordinal order, paths are written
with `/`, entities are sorted by natural key, the JSON is written exactly as
JavaScript's `JSON.stringify` would. That is what makes a downloaded binary
checkable in one line:

```bash
codegraph-csharp --src fixtures/csharp/src --out /tmp/m.jsonl --progress none \
  && cmp /tmp/m.jsonl fixtures/csharp/expected/model.jsonl && echo same
```

Run it from the repository root with that relative `--src`: the typed path is
the header's `root`, so an absolute one differs from the snapshot at byte 138
and says nothing about the binary.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `dotnet: command not found` in a script that works in your terminal | non-interactive shells do not source the login profile | `export DOTNET_ROOT=~/.dotnet; export PATH=$DOTNET_ROOT:$PATH` in the script, or call the self-contained binary |
| `You must install or update .NET to run this application` | runtime older than 10 (the extractor rolls forward only to newer majors) | install the 10.0 runtime (§2) |
| `Couldn't find a valid ICU package` | not this extractor — it is built with invariant globalization; another .NET app on the box | `apt install libicu` for that app |
| `No BCL reference assemblies found …` at build time | the SDK's targeting pack is missing (partial distro package) | `apt install dotnet-targeting-pack-10.0`, or the official install script |
| every `System.*` type shows up under `<unresolved>` | a hand-published single-file build that reads the BCL from `Assembly.Location`, which is empty in a bundle | use `./build.sh --csharp`; the embedded pack is verified at build time |
| macOS: `"codegraph-csharp" cannot be opened because the developer cannot be verified` | unsigned download | `xattr -d com.apple.quarantine codegraph-csharp` |
| a `codegraph.jsonl` with far fewer types than expected | `--src` pointed below the sources, or generated code lives outside the roots | point `--src` at the solution folder; add roots with repeated `--src` |
| the header's `root` is absolute | `--src` was typed absolute | type it relative to the directory you run from |
