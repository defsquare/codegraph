# Codegraph desktop — the shell

A Tauri 2 window over the codegraph daemon (PLAN.md §15.4). The app is the
`codegraph serve --app` page, served by the single-executable `codegraph`
that rides in the bundle as its one sidecar; this crate is what stands
between the OS and that daemon, and nothing more:

- **discovery** (`discovery/`, pure Rust): the extractor catalogue
  (`src-tauri/resources/extractors.json` — one row per extractor codegraph
  knows: name, extensions, command, install line) looked up on `PATH` and in
  the Homebrew prefixes, written as the daemon's registry
  (`<app data>/registry.json`). An extractor that is not found is written
  without a `path` and with its install line, so the daemon can answer a
  folder of that language with `brew install …` rather than "nothing claims
  these files". `<app data>/settings.json` may override a row:
  `{ "overrides": [{ "name": "typescript", "path": "/src/bin/codegraph-typescript" }] }`.
- **the daemon's lifetime** (`src-tauri/src/daemon.rs`): spawn the sidecar
  with stdin held open, read its one stdout line, keep the child; close
  stdin and kill it on window close.
- **the shell** (`src-tauri/src/lib.rs`): navigate the webview to the
  daemon's URL; File › Open Folder… (native dialog), Open Recent (from the
  daemon's `recent` route), Rescan Extractors; a folder dropped on the
  window. Each is one `POST jobs`; a refusal is a native dialog. Discovery
  runs again on every window focus, so a `brew install` in a terminal is
  seen on the next open.

No IPC in the page: the page is a remote origin the capability file does
not list, so it has no Tauri API at all and talks to the daemon over HTTP
exactly as it does in a browser.

## Run it from a checkout

Needs a Rust toolchain and Tauri's platform libraries
(https://tauri.app/start/prerequisites/ — WebKitGTK on Linux, Xcode's
command-line tools on macOS, WebView2 on Windows).

```
./build.sh --ts --sea                       # the sidecar: packages/cli/dist-sea/<rid>/codegraph
pnpm --filter @codegraph/desktop tauri:dev  # copies it to src-tauri/binaries/codegraph-<triple>, then `tauri dev`
```

`cargo test --workspace` in this directory runs the discovery crate's tests
and compiles the shell; `cargo test -p codegraph-discovery` runs the former
on any machine, WebKit or not.

## The WebGL gate (PLAN.md §15.4)

Before anything else on a Mac: open the fineract city (the NV milestone's
100 MB artifact) in `tauri dev`, look at it from user-facing angles, measure
the frame time. WKWebView is not Chrome; a failure here changes the plan to
a Chromium-based shell and is cheaper to learn first. This gate has not been
run yet — this crate was written on a Linux machine without WebKitGTK,
compiled by CI only.

## Layout

```
Cargo.toml                 the Cargo workspace: discovery + src-tauri
discovery/                 codegraph-discovery (serde, serde_json; tests)
src-tauri/                 the Tauri crate
  tauri.conf.json          one window, one sidecar (binaries/codegraph), the catalogue as a resource
  capabilities/default.json  the shell's permissions; the page gets none
  resources/extractors.json  the catalogue — a new extractor is one row
  entitlements.plist       the JIT trio the sidecar (V8) needs under the hardened runtime
  icons/                   from `tauri icon app-icon.png`
  binaries/                (ignored) the sidecar, placed by scripts/sidecar.mjs
dist/index.html            the one-line "starting…" page the daemon's page replaces
scripts/sidecar.mjs        packages/cli/dist-sea/<rid>/codegraph → src-tauri/binaries/codegraph-<triple>
```
