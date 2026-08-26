#!/usr/bin/env bash
#
# build.sh — build every artifact a working codegraph install needs.
#
#   TypeScript : pnpm -r build   -> packages/*/dist (incl. the viz bundle
#                                   `codegraph city --serve` looks for)
#   Java       : ./mvnw package  -> extractors/java/target/codegraph-java.jar
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

usage() {
  cat <<'USAGE'
Usage: ./build.sh [options]

  Builds the TypeScript workspace and the Java extractor.

Options:
  --ts, --ts-only      only packages/* (pnpm -r build)
  --java, --java-only  only extractors/java (./mvnw package)
  --all                both (default)
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
    -h|--help)  usage; exit 0 ;;
    *)          usage_error "unknown option: $1" ;;
  esac
  shift
done

printf '%scodegraph build%s  %s(%s)%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$ROOT" "$C_RESET"

# ---------------------------------------------------------------- checks ----

step "toolchain"
if wants_ts; then check_node; ensure_pnpm; fi
if wants_java; then
  if have_java_extractor; then ensure_jdk; ensure_mvnw
  else warn "no extractors/java in this checkout — skipping the Java build"; TARGET="ts"; fi
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

if wants_java; then
  step "build java extractor (./mvnw package)"
  # -B: batch mode, no ANSI progress spam in logs. Tests belong to test.sh.
  ( cd "$JAVA_DIR" && run ./mvnw -B -DskipTests package )
  step_done
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
if wants_java; then report "$JAVA_DIR/target/codegraph-java.jar"; fi
[ "$missing" -eq 0 ] || die "$missing expected artifact(s) missing — the build did not produce a usable tree"
step_done

summary
printf '\nRun it:  %s./bin/codegraph --version%s\n' "$C_BOLD" "$C_RESET"
