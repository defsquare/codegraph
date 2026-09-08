#!/usr/bin/env bash
#
# test.sh — run the acceptance gate: what .github/workflows/ci.yml verifies,
# on your machine, with the toolchain checks CI gets from its runner images.
#
#   typecheck  pnpm -r typecheck
#   unit       pnpm -r test            (vitest + fast-check property suites)
#   schemas    pnpm run gen:schemas must be a NO-OP — schemas/ is a committed
#              artifact and the cross-language contract; drift there is a bug
#   java       ./mvnw test, then the NATIVE binary (if build.sh made one)
#              re-extracts fixtures/java/src and must reproduce the committed
#              snapshot — the only test that sees the image's own code path: no
#              java.home, no VM class library, the embedded ct.sym reference
#   csharp     dotnet test, then the PUBLISHED binary (if build.sh made one)
#              re-extracts fixtures/csharp/src and must reproduce the committed
#              snapshot byte for byte — the only test that sees the single-file
#              code path (embedded BCL, no Assembly.Location)
#
# No build is required first: packages/cli/vitest.config.ts aliases the
# workspace packages to their SOURCE, and the CLI e2e suite builds its own dist
# on demand. Keeping that true is why this script never calls build.sh.
#
# Every phase runs even after an earlier one fails, so one run tells you
# everything that is broken. --fail-fast opts out.

SCRIPT_NAME="test.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/lib.sh"
trap on_error ERR

FAIL_FAST="no"
RUN_LINT="no"
RUN_TYPECHECK="yes"
RUN_SCHEMAS="yes"

usage() {
  cat <<'USAGE'
Usage: ./test.sh [options]

  Runs the full verification gate for the TypeScript workspace and the Java
  extractor. Exit 0 only if every phase passed.

Options:
  --ts, --ts-only      only packages/* (typecheck, vitest, schema drift)
  --java, --java-only  only extractors/java (./mvnw test)
  --csharp, --csharp-only
                       only extractors/csharp (dotnet test + published-binary smoke test)
  --all                everything (default)
  --lint               also run eslint (not part of CI's gate)
  --no-typecheck       skip pnpm -r typecheck
  --no-schemas         skip the schemas/ drift check
  --fail-fast          stop at the first failing phase
  --skip-install       do not run pnpm install (requires an existing node_modules)
  --no-frozen          allow pnpm install to update pnpm-lock.yaml
  --no-auto-install    never provision pnpm via corepack; fail with instructions
  -h, --help           this text

Examples:
  ./test.sh                     # the whole gate
  ./test.sh --ts --fail-fast    # tight inner loop on the TS side
  ./test.sh --java
USAGE
}

while [ $# -gt 0 ]; do
  if parse_common_flag "$1"; then shift; continue; fi
  case "$1" in
    --lint)          RUN_LINT="yes" ;;
    --no-typecheck)  RUN_TYPECHECK="no" ;;
    --no-schemas)    RUN_SCHEMAS="no" ;;
    --fail-fast)     FAIL_FAST="yes" ;;
    -h|--help)       usage; exit 0 ;;
    *)               usage_error "unknown option: $1" ;;
  esac
  shift
done

FAILURES=""

# phase <name> <cmd...> — run it, remember the verdict, keep going.
# The command runs in an `if` condition, where errexit and the ERR trap are
# suspended by definition — that is what makes "report everything" possible
# without disarming the trap the rest of the script relies on.
phase() {
  local name="$1"; shift
  step "$name"
  if run "$@"; then
    step_done
  else
    fail "$name FAILED"
    FAILURES="${FAILURES}${name}
"
    SUMMARY="${SUMMARY}${name} (FAILED)	$(( SECONDS - STEP_T0 ))
"
    if [ "$FAIL_FAST" = "yes" ]; then verdict || true; exit 1; fi
  fi
  STEP_NAME=""
}

verdict() {
  summary
  if [ -n "$FAILURES" ]; then
    printf '\n%sFAILED:%s\n' "$C_RED$C_BOLD" "$C_RESET"
    printf '%s' "$FAILURES" | while read -r name; do [ -n "$name" ] && printf '  - %s\n' "$name"; done
    return 1
  fi
  printf '\n%sAll checks passed.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
  return 0
}

printf '%scodegraph test%s  %s(%s)%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$ROOT" "$C_RESET"

# ---------------------------------------------------------------- checks ----

step "toolchain"
if wants_ts; then check_node; ensure_pnpm; fi
SKIP_JAVA="no"; SKIP_CSHARP="no"
if wants_java; then
  if have_java_extractor; then ensure_jdk; ensure_mvnw
  else warn "no extractors/java in this checkout — skipping the Java tests"; SKIP_JAVA="yes"; fi
fi
if wants_csharp; then
  if have_csharp_extractor; then ensure_dotnet
  else warn "no extractors/csharp in this checkout — skipping the C# tests"; SKIP_CSHARP="yes"; fi
fi
step_done

# ------------------------------------------------------------ typescript ----

if wants_ts; then
  pnpm_install

  if [ "$RUN_TYPECHECK" = "yes" ]; then phase "typecheck" pnpm --dir "$ROOT" -r typecheck; fi
  if [ "$RUN_LINT" = "yes" ];      then phase "lint" pnpm --dir "$ROOT" run lint; fi

  phase "unit + property tests" pnpm --dir "$ROOT" -r test

  # Regenerating a committed artifact must change nothing. Only meaningful
  # against a clean working tree: if schemas/ is already edited, the diff would
  # blame this run for the user's own in-progress change.
  if [ "$RUN_SCHEMAS" = "yes" ]; then
    if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
      warn "not a git checkout — skipping the schemas/ drift check"
    elif ! git -C "$ROOT" diff --quiet -- schemas/ 2>/dev/null; then
      warn "schemas/ has uncommitted changes — skipping the drift check"
      warn "  commit or stash them, then re-run to verify generation is a no-op"
    else
      phase "schemas are up to date" \
        sh -c "cd '$ROOT' && pnpm run gen:schemas >/dev/null && git diff --exit-code --stat -- schemas/"
      case "$FAILURES" in
        *"schemas are up to date"*)
          warn "schemas/ is stale — commit the regenerated files with the core change that caused them" ;;
      esac
    fi
  fi
fi

# ------------------------------------------------------------------ java ----

if wants_java && [ "$SKIP_JAVA" = "no" ]; then
  phase "java extractor tests (./mvnw test)" \
    sh -c "cd '$JAVA_DIR' && ./mvnw -B test"

  # The same acceptance check the C# binary gets, and for the same reason: a
  # native image is a different runtime, not a repackaging. It has no java.home,
  # so ECJ finds no platform library and falls back to the ct.sym reference the
  # build embedded — a path NO jvm test can exercise. If that reference were
  # missing or wrong the model would still be produced, just quietly worse
  # (types the corpus never declared, ~10 points of resolution), which is exactly
  # the kind of regression a snapshot catches and a summary line does not.
  #
  # Unlike C#, the model's `root` is the ABSOLUTE path the run was pointed at, so
  # the comparison normalises it the way SnapshotTest does — and nothing else.
  bin="$JAVA_DIR/dist/$(host_rid)/codegraph-java"
  [ -x "$bin" ] || bin="$bin.exe"
  if [ -x "$bin" ]; then
    corpus="$(cd "$ROOT/fixtures/java/src" && pwd -P)"
    phase "native java binary reproduces the snapshot" \
      sh -c "cd '$ROOT' && out=\$(mktemp) && '$bin' --src fixtures/java/src --out \"\$out\" --progress none >/dev/null 2>&1 && sed 's|\"$corpus\"|\"fixtures/java/src\"|' \"\$out\" | cmp - fixtures/java/expected/model.jsonl; rc=\$?; rm -f \"\$out\"; exit \$rc"
  else
    warn "no native binary at $JAVA_DIR/dist/$(host_rid) — run ./build.sh --java --native for the smoke test"
  fi
fi

# ---------------------------------------------------------------- csharp ----

if wants_csharp && [ "$SKIP_CSHARP" = "no" ]; then
  phase "csharp extractor tests (dotnet test)" \
    sh -c "cd '$CSHARP_DIR' && dotnet test -c Release --nologo -v quiet"

  # The cross-OS acceptance check (PLAN.md §13 principle 3): the published
  # artifact, not `dotnet run`, must reproduce the snapshot exactly. Run from
  # the repo root with the SAME relative --src the snapshot was made with: the
  # typed path is the header's `root`, so an absolute one differs at byte 138.
  bin="$CSHARP_DIR/dist/$(host_rid)/codegraph-csharp"
  [ -x "$bin" ] || bin="$bin.exe"
  if [ -x "$bin" ]; then
    phase "published csharp binary reproduces the snapshot" \
      sh -c "cd '$ROOT' && out=\$(mktemp) && '$bin' --src fixtures/csharp/src --out \"\$out\" --progress none >/dev/null 2>&1 && cmp \"\$out\" fixtures/csharp/expected/model.jsonl; rc=\$?; rm -f \"\$out\"; exit \$rc"
  else
    warn "no published binary at $CSHARP_DIR/dist/$(host_rid) — run ./build.sh --csharp for the smoke test"
  fi
fi

# The ERR trap must not fire here: `verdict` reporting failures IS the result.
if verdict; then exit 0; else exit 1; fi
