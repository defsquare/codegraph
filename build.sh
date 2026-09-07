#!/usr/bin/env bash
#
# build.sh — build every artifact a working codegraph install needs.
#
#   TypeScript : pnpm -r build   -> packages/*/dist (incl. the viz bundle
#                                   `codegraph city --serve` looks for)
#   Java       : ./mvnw package  -> extractors/java/target/codegraph-java.jar
#   C#         : dotnet publish  -> extractors/csharp/dist/<rid>/codegraph-csharp
#                                   (self-contained single file; --publish-all
#                                   builds the five-RID matrix from this host)
#
# Wraps both with the toolchain checks that a bare `pnpm`/`mvnw` invocation
# skips: Node's floor, the pinned pnpm, and a JDK that non-interactive shells
# cannot see because they never source sdkman.
#
# Tests are NOT run here — that is test.sh. `--skip-tests` on the Maven side is
# therefore deliberate, not a shortcut.

SCRIPT_NAME="build.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/lib.sh"
trap on_error ERR

CLEAN="no"
PUBLISH_ALL="no"
PUBLISH_RID=""

usage() {
  cat <<'USAGE'
Usage: ./build.sh [options]

  Builds the TypeScript workspace and the Java extractor.

Options:
  --ts, --ts-only      only packages/* (pnpm -r build)
  --java, --java-only  only extractors/java (./mvnw package)
  --csharp, --csharp-only
                       only extractors/csharp (dotnet publish, host RID)
  --publish-all        C#: publish linux-x64, linux-arm64, osx-x64, osx-arm64, win-x64
  --rid <rid>          C#: publish exactly this RID (what the CI matrix calls, one per job)
  --all                everything (default)
  --clean              discard previous output first (dist/, target/)
  --skip-install       do not run pnpm install (requires an existing node_modules)
  --no-frozen          allow pnpm install to update pnpm-lock.yaml
  --no-auto-install    never provision pnpm via corepack; fail with instructions
  -h, --help           this text

Examples:
  ./build.sh                    # everything, lockfile frozen
  ./build.sh --ts --skip-install
  ./build.sh --java --clean
USAGE
}

while [ $# -gt 0 ]; do
  if parse_common_flag "$1"; then shift; continue; fi
  case "$1" in
    --clean)    CLEAN="yes" ;;
    --publish-all) PUBLISH_ALL="yes" ;;
    --rid)
      [ $# -ge 2 ] || usage_error "--rid needs a value"
      PUBLISH_RID="$2"; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          usage_error "unknown option: $1" ;;
  esac
  shift
done

printf '%scodegraph build%s  %s(%s)%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$ROOT" "$C_RESET"

# ---------------------------------------------------------------- checks ----

step "toolchain"
if wants_ts; then check_node; ensure_pnpm; fi
SKIP_JAVA="no"; SKIP_CSHARP="no"
if wants_java; then
  if have_java_extractor; then ensure_jdk; ensure_mvnw
  else warn "no extractors/java in this checkout — skipping the Java build"; SKIP_JAVA="yes"; fi
fi
if wants_csharp; then
  if have_csharp_extractor; then ensure_dotnet
  else warn "no extractors/csharp in this checkout — skipping the C# build"; SKIP_CSHARP="yes"; fi
fi
step_done

# ------------------------------------------------------------ typescript ----

if wants_ts; then
  pnpm_install

  if [ "$CLEAN" = "yes" ]; then
    step "clean (typescript)"
    run rm -rf "$ROOT"/packages/*/dist
    step_done
  fi

  step "build typescript (pnpm -r build)"
  run pnpm --dir "$ROOT" -r build
  step_done
fi

# ------------------------------------------------------------------ java ----

if wants_java && [ "$SKIP_JAVA" = "no" ]; then
  step "build java extractor (./mvnw package)"
  # -B: batch mode, no ANSI progress spam in logs. Tests belong to test.sh.
  ( cd "$JAVA_DIR" && run ./mvnw -B -DskipTests package )
  step_done
fi

# ---------------------------------------------------------------- csharp ----

# One self-contained single-file binary per RID (PLAN.md §13.7): the runtime,
# Roslyn and the embedded BCL reference pack travel inside it, so the machine
# that runs it needs no SDK. ReadyToRun for startup; never trimmed (Roslyn is
# not trim-clean). Every RID cross-publishes from any host.
publish_csharp() {
  local rid="$1"
  ( cd "$CSHARP_DIR" && run dotnet publish src/Codegraph.CSharp -c Release -r "$rid" --self-contained \
      -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:PublishReadyToRun=true \
      -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none \
      -o "dist/$rid" --nologo -v quiet )
}

if wants_csharp && [ "$SKIP_CSHARP" = "no" ]; then
  if [ "$CLEAN" = "yes" ]; then
    step "clean (csharp)"
    run rm -rf "$CSHARP_DIR/dist" "$CSHARP_DIR"/src/*/bin "$CSHARP_DIR"/src/*/obj "$CSHARP_DIR"/tests/*/bin "$CSHARP_DIR"/tests/*/obj
    step_done
  fi
  if [ -n "$PUBLISH_RID" ]; then
    step "publish csharp extractor ($PUBLISH_RID)"
    publish_csharp "$PUBLISH_RID"
    step_done
  elif [ "$PUBLISH_ALL" = "yes" ]; then
    for rid in linux-x64 linux-arm64 osx-x64 osx-arm64 win-x64; do
      step "publish csharp extractor ($rid)"
      publish_csharp "$rid"
      step_done
    done
  else
    step "publish csharp extractor ($(host_rid))"
    publish_csharp "$(host_rid)"
    step_done
  fi
fi

# -------------------------------------------------------------- artifacts ---

step "artifacts"
missing=0
report() {
  if [ -e "$1" ]; then
    printf '  %s✓%s %-46s %s\n' "$C_GREEN" "$C_RESET" "${1#$ROOT/}" "$(du -h "$1" | cut -f1)"
  else
    printf '  %s✗%s %-46s %smissing%s\n' "$C_RED" "$C_RESET" "${1#$ROOT/}" "$C_RED" "$C_RESET"
    missing=$(( missing + 1 ))
  fi
}
if wants_ts; then
  for pkg in core analyzer city navigator cli; do report "$ROOT/packages/$pkg/dist/index.js"; done
  # viz and navigator-ui ship Vite apps, not modules: their entry point is the
  # HTML the CLI serves. Their absence is what breaks `--serve`, so name them.
  report "$ROOT/packages/viz/dist/index.html"
  report "$ROOT/packages/navigator-ui/dist/index.html"
fi
if wants_java && [ "$SKIP_JAVA" = "no" ]; then report "$JAVA_DIR/target/codegraph-java.jar"; fi
report_rid() {
  case "$1" in
    win-*) report "$CSHARP_DIR/dist/$1/codegraph-csharp.exe" ;;
    *)     report "$CSHARP_DIR/dist/$1/codegraph-csharp" ;;
  esac
}
if wants_csharp && [ "$SKIP_CSHARP" = "no" ]; then
  if [ -n "$PUBLISH_RID" ]; then report_rid "$PUBLISH_RID"
  elif [ "$PUBLISH_ALL" = "yes" ]; then
    for rid in linux-x64 linux-arm64 osx-x64 osx-arm64 win-x64; do report_rid "$rid"; done
  else report_rid "$(host_rid)"; fi
fi
[ "$missing" -eq 0 ] || die "$missing expected artifact(s) missing — the build did not produce a usable tree"
step_done

summary
printf '\nRun it:  %s./bin/codegraph --version%s\n' "$C_BOLD" "$C_RESET"
