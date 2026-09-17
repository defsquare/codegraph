# Distribution — Homebrew, the release, and what signs what

Codegraph is installed from one Homebrew tap, `defsquare/homebrew-tap`. The
app is ONE install and every language extractor is its OWN install, so a
user of one language never downloads the runtimes of the others
(PLAN.md §15):

```
brew install --cask defsquare/tap/codegraph            # Codegraph.app + `codegraph` on PATH
brew install defsquare/tap/codegraph-java               # one per language, as needed
brew install defsquare/tap/codegraph-csharp
brew install defsquare/tap/codegraph-typescript
```

The app finds the extractors that are installed; a folder whose language has
none is answered with the line above that fixes it.

## What a tagged release produces

Pushing a `v*` tag runs `.github/workflows/ci.yml` end to end. The jobs that
matter for distribution, and their outputs on the GitHub release:

| Job | Output on the release |
|---|---|
| `java-native` (five runners) | `codegraph-java-<rid>` — the GraalVM native image |
| `csharp-publish` (five RIDs from Linux) | `codegraph-csharp-<rid>` — the .NET single-file binary |
| `sea` (five runners) | `codegraph-<rid>` — the single-executable CLI + daemon + frontends |
| `desktop-bundle` (two macOS runners) | `Codegraph-<version>-osx-arm64.dmg`, `Codegraph-<version>-osx-x64.dmg` |
| `npm-publish` | `codegraph-typescript@<version>` on npm (not on the release) |
| `release` | `SHA256SUMS` over every asset, then the tap rendered and pushed |

`<rid>` is one of `linux-x64`, `linux-arm64`, `osx-x64`, `osx-arm64`,
`win-x64`; Windows assets end in `.exe`.

## The tap's files, generated

`scripts/homebrew/render.mjs` renders every file of the tap from the
release's `SHA256SUMS` — never edit them by hand, the next release would
overwrite the edit:

```
node scripts/homebrew/render.mjs --version 0.1.0 --sums release/SHA256SUMS \
     --npm-sha256 <sha256 of the npm tarball> --out tap
```

- `Casks/codegraph.rb`: `arch arm:/intel:`, one DMG URL and `sha256` per
  architecture, `app "Codegraph.app"` and ONE `binary` stanza — the
  single-executable inside the bundle. `auto_updates false`, a `livecheck`
  on the release tags; `brew upgrade` is the update path, the Tauri updater
  is off.
- `Formula/codegraph-java.rb`, `Formula/codegraph-csharp.rb`: `on_macos` /
  `on_linux` × `on_arm` / `on_intel` blocks with the asset URL and sum,
  `bin.install` renaming the asset to the command, a `test do` that runs
  `--version` and extracts a one-file tree. A prebuilt binary in a formula is
  legitimate in our own tap (homebrew-core refuses vendored binaries).
- `Formula/codegraph-typescript.rb`: the npm package on Homebrew's `node`
  (`depends_on "node"`, `std_npm_args`), rendered only when the npm publish
  happened for this version.

`node --test scripts/homebrew` (part of `test.sh`) pins the asset names the
templates reference to the ones the release job writes.

## Secrets the workflow reads

All optional: without them the corresponding step is skipped with a notice,
never failed, so a fork or a pull request still builds everything unsigned.

| Secret | Used by | What it is |
|---|---|---|
| `APPLE_CERTIFICATE` | `desktop-bundle` | the Developer ID Application certificate, a `.p12` base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | `desktop-bundle` | its password |
| `APPLE_SIGNING_IDENTITY` | `desktop-bundle` | `Developer ID Application: <name> (<team>)` — its presence switches signing on |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | `desktop-bundle` | the Apple ID, an app-specific password, the team — Tauri notarizes with them |
| `NPM_TOKEN` | `npm-publish` | publishes `codegraph-typescript` |
| `HOMEBREW_TAP_DEPLOY_KEY` | `release` | an SSH deploy key with write access to the tap repository (`vars.HOMEBREW_TAP_REPO`, default `defsquare/homebrew-tap`) |

## What is signed, and how

- The sidecar (`codegraph`, a Node single-executable) is signed by CI
  itself, before `tauri build`, with hardened runtime and
  `apps/desktop/src-tauri/entitlements.plist` — the JIT trio V8 needs. The
  plan (§15.5) says not to assume the bundler applies entitlements to a
  sidecar, so the job does it and verifies the signature.
- `tauri build` signs `Codegraph.app` with the same identity and hardened
  runtime, then notarizes when the Apple ID variables are present.
- The job then asserts what §15.5 asks to confirm on the first signed build:
  `codesign --verify --deep --strict` on the app, the `allow-jit`
  entitlement present on the embedded `codegraph`, and `spctl --assess`
  accepting the app.
- The extractor binaries are formula downloads, not bundle contents;
  Homebrew fetches them with `curl`, which sets no quarantine attribute.
  arm64 still refuses an unsigned Mach-O, which the GraalVM image and the
  .NET single-file host satisfy with an ad-hoc signature. Whether a Developer
  ID signature on them is also needed is decided by the first clean-Mac
  install, and the answer belongs in the extractor's profile notes.

## Status

The pipeline and the generators are written and tested; the tap has not yet
received a release. Reaching the definition of done in PLAN.md §15.6 —
a clean Mac running the install lines and opening a Java, a C# and a
TypeScript folder from the app — needs, in order: the Apple credentials and
the tap deploy key in the repository's secrets, the `defsquare/homebrew-tap`
repository (an empty repository with `Casks/` and `Formula/` is enough), a
`v*` tag, and the two clean-Mac checks by hand.
