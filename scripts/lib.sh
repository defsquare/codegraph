# Shared preflight for build.sh and test.sh. Sourced, never executed.
#
# One definition of "can this machine build codegraph", so the two entry points
# can never disagree about it. Every requirement is READ FROM THE FILE THAT OWNS
# IT — Node's floor from package.json `engines`, pnpm's pin from
# `packageManager`, the JDK's floor from extractors/java/pom.xml — so bumping a
# requirement never needs a second edit here.
#
# Bash 3.2 compatible on purpose: that is what macOS ships, and macOS is where
# this has to work for the Homebrew install path.

set -euo pipefail

# Resolved relative to THIS file, not to the caller's cwd, so `../build.sh`,
# `~/codegraph/build.sh` and a symlinked checkout all reach their own tree.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JAVA_DIR="$ROOT/extractors/java"

# ---------------------------------------------------------------- output ----

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_DIM=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail() { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }

# die <message> [hint...] — one reason, then the commands that fix it.
die() {
  fail "$1"; shift
  for hint in "$@"; do printf '  %s%s%s\n' "$C_DIM" "$hint" "$C_RESET" >&2; done
  exit 1
}

usage_error() { fail "$*"; printf '  %sRun with --help.%s\n' "$C_DIM" "$C_RESET" >&2; exit 2; }

# Section header. Steps are what the summary reports on.
STEP_NAME=""
STEP_T0=0
step() {
  STEP_NAME="$1"; STEP_T0=$SECONDS
  printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$1" "$C_RESET"
}

# Steps that ran, as "name<TAB>seconds" lines — Bash 3.2 has no assoc arrays.
SUMMARY=""
step_done() {
  local secs=$(( SECONDS - STEP_T0 ))
  SUMMARY="${SUMMARY}${STEP_NAME}	${secs}
"
  ok "$STEP_NAME (${secs}s)"
}

# The failing step names itself, so a wall of pnpm/maven output still ends with
# one legible line saying which phase died.
on_error() {
  local code=$?
  printf '\n'
  if [ -n "$STEP_NAME" ]; then fail "$SCRIPT_NAME failed during: $STEP_NAME (exit $code)"
  else fail "$SCRIPT_NAME failed (exit $code)"; fi
  exit $code
}

summary() {
  printf '\n%s%s%s\n' "$C_BOLD" "$SCRIPT_NAME — done" "$C_RESET"
  printf '%s' "$SUMMARY" | while IFS=$'\t' read -r name secs; do
    if [ -n "$name" ]; then printf '  %s%-38s%s %ss\n' "$C_DIM" "$name" "$C_RESET" "$secs"; fi
  done
  printf '  %s%-38s%s %ss\n' "$C_DIM" "total" "$C_RESET" "$SECONDS"
}

# `run <cmd...>` — echo it, then run it. Every external command a script runs is
# visible, so a failure can be reproduced by copy-paste.
run() {
  printf '%s$ %s%s\n' "$C_DIM" "$*" "$C_RESET"
  "$@"
}

# ---------------------------------------------------- required versions -----

# ">=22" in engines.node -> 22. The floor, not a range solver: these three
# parsers accept the shapes this repo actually writes and die on anything else
# rather than guessing.
req_node_major() {
  local v
  v="$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*">=\{0,1\}\([0-9][0-9]*\).*/\1/p' "$ROOT/package.json" | head -1)"
  [ -n "$v" ] || die "cannot read engines.node from $ROOT/package.json"
  printf '%s' "$v"
}

# "pnpm@10.15.0" -> 10.15.0
req_pnpm_version() {
  local v
  v="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
  [ -n "$v" ] || die "cannot read packageManager from $ROOT/package.json"
  printf '%s' "$v"
}

# <maven.compiler.release>17</...> -> 17
req_java_major() {
  local v
  v="$(sed -n 's:.*<maven\.compiler\.release>\([0-9][0-9]*\)</maven\.compiler\.release>.*:\1:p' "$JAVA_DIR/pom.xml" | head -1)"
  [ -n "$v" ] || die "cannot read maven.compiler.release from $JAVA_DIR/pom.xml"
  printf '%s' "$v"
}

# ------------------------------------------------------- node toolchain -----

check_node() {
  local want have
  want="$(req_node_major)"
  command -v node >/dev/null 2>&1 || die \
    "node is not on PATH (codegraph needs Node >= $want)" \
    "nvm:      nvm install $want && nvm use $want" \
    "homebrew: brew install node@$want"
  have="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$have" -ge "$want" ] || die \
    "Node $have is too old — codegraph needs >= $want (package.json engines)" \
    "nvm:      nvm install $want && nvm use $want" \
    "homebrew: brew install node@$want"
  ok "node $(node -v) (>= $want)"
}

# pnpm is PINNED by packageManager. corepack is the sanctioned way to honour
# that pin, so a missing pnpm is auto-provisioned through it — corepack writes
# shims next to the current node, which is user-owned under nvm/homebrew and
# needs no sudo. A global install is only ever SUGGESTED, never performed.
ensure_pnpm() {
  local want have
  want="$(req_pnpm_version)"

  if ! command -v pnpm >/dev/null 2>&1; then
    if [ "$AUTO_INSTALL" = "no" ]; then
      die "pnpm is not on PATH and --no-auto-install was given" \
          "corepack: corepack enable pnpm" \
          "npm:      npm install -g pnpm@$want"
    fi
    command -v corepack >/dev/null 2>&1 || die \
      "pnpm is not on PATH and corepack is unavailable to install it" \
      "npm:      npm install -g pnpm@$want" \
      "homebrew: brew install pnpm"
    warn "pnpm missing — provisioning pnpm@$want via corepack"
    run corepack enable pnpm || die \
      "corepack could not install pnpm (no write access to $(dirname "$(command -v node)")?)" \
      "npm: npm install -g pnpm@$want"
  fi

  have="$(pnpm --version)"
  if [ "$have" != "$want" ]; then
    # Not fatal: a different pnpm still installs this lockfile. It is worth
    # saying out loud, because lockfile churn between pnpm majors is real.
    warn "pnpm $have differs from the pinned pnpm@$want (packageManager)"
    warn "  corepack use pnpm@$want   # to match exactly"
  fi
  ok "pnpm $have"
}

# --frozen-lockfile by default: a build that silently rewrites pnpm-lock.yaml is
# not the build CI runs. --no-frozen is the escape hatch for adding a dep.
pnpm_install() {
  if [ "$SKIP_INSTALL" = "yes" ]; then
    warn "skipping pnpm install (--skip-install)"
    [ -d "$ROOT/node_modules" ] || die \
      "…but $ROOT/node_modules does not exist, so nothing can run" \
      "drop --skip-install, or run: pnpm install"
    return 0
  fi
  step "pnpm install"
  if [ "$FROZEN" = "yes" ]; then
    run pnpm --dir "$ROOT" install --frozen-lockfile
  else
    run pnpm --dir "$ROOT" install
  fi
  step_done
}

# ------------------------------------------------------- java toolchain -----

have_java_extractor() { [ -f "$JAVA_DIR/pom.xml" ]; }

# "openjdk version \"25.0.4\"" -> 25 ; legacy "1.8.0_402" -> 8
_java_major() {
  "$1" -version 2>&1 | sed -n '1s/.*version "\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p' \
    | awk '{ if ($1 == 1) print $2; else print $1 }' | head -1
}

_java_home_of() { "$1" -XshowSettings:properties -version 2>&1 | sed -n 's/^ *java\.home = //p' | head -1; }

# <java-bin> -> the JDK home that owns it, or nothing.
#
# `java.home` points at the runtime image, which for a JRE-only install (a
# system `/bin/java` alternative, typically) has no `bin/javac`. The extractor
# compiles, so a JRE is not a candidate at all — skipped here rather than
# accepted and diagnosed later.
_jdk_home_of() {
  local bin="$1" home
  home="$(_java_home_of "$bin")"
  if [ -n "$home" ] && [ -x "$home/bin/javac" ]; then printf '%s' "$home"; return 0; fi
  home="$(cd "$(dirname "$(dirname "$bin")")" 2>/dev/null && pwd)" || return 1
  if [ -n "$home" ] && [ -x "$home/bin/javac" ]; then printf '%s' "$home"; return 0; fi
  return 1
}

# Resolve a JDK >= the pom's release floor and EXPORT JAVA_HOME for ./mvnw.
#
# Non-interactive shells do not source sdkman (CLAUDE.md says so explicitly),
# which is why $HOME/.sdkman is probed directly rather than assumed to be on
# PATH. A JDK is never installed automatically — that is a multi-hundred-MB
# decision the user makes, so this prints the exact command and stops.
ensure_jdk() {
  local want candidate home major best_home="" best_major=0 saw_jre="no"
  want="$(req_java_major)"

  # Search order: an explicit JAVA_HOME, then `java` on PATH, then sdkman's
  # selected JDK, then any sdkman candidate (an old `current` is a shell
  # setting, not a missing JDK), then macOS's own registry.
  set --
  if [ -n "${JAVA_HOME:-}" ]; then set -- "$JAVA_HOME/bin/java"; fi
  set -- "$@" "$(command -v java 2>/dev/null || true)" "$HOME/.sdkman/candidates/java/current/bin/java"
  for candidate in "$HOME"/.sdkman/candidates/java/*/bin/java; do
    if [ -x "$candidate" ]; then set -- "$@" "$candidate"; fi
  done
  if [ -x /usr/libexec/java_home ]; then
    home="$(/usr/libexec/java_home -v "$want+" 2>/dev/null || true)"
    if [ -n "$home" ]; then set -- "$@" "$home/bin/java"; fi
  fi

  for candidate in "$@"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    major="$(_java_major "$candidate")"
    [ -n "$major" ] || continue
    home="$(_jdk_home_of "$candidate" || true)"
    if [ -z "$home" ]; then saw_jre="yes"; continue; fi
    # First candidate clearing the floor wins — the search order IS the
    # preference order. Lower ones are remembered only to say how short they fall.
    if [ "$major" -ge "$want" ]; then best_home="$home"; best_major="$major"; break; fi
    if [ "$major" -gt "$best_major" ]; then best_home="$home"; best_major="$major"; fi
  done

  if [ -z "$best_home" ]; then
    if [ "$saw_jre" = "yes" ]; then
      die "only a JRE was found — the Java extractor must compile, so it needs a JDK >= $want" \
          "sdkman:   sdk install java 25.0.4-tem" \
          "homebrew: brew install --cask temurin" \
          "or skip it entirely: $SCRIPT_NAME --ts"
    fi
    die "no JDK found — the Java extractor needs JDK >= $want (pom.xml maven.compiler.release)" \
        "sdkman:   sdk install java 25.0.4-tem" \
        "homebrew: brew install --cask temurin" \
        "or skip it entirely: $SCRIPT_NAME --ts"
  fi

  [ "$best_major" -ge "$want" ] || die \
    "JDK $best_major ($best_home) is too old — the extractor needs >= $want" \
    "sdkman:   sdk install java 25.0.4-tem && sdk use java 25.0.4-tem" \
    "homebrew: brew install --cask temurin"

  export JAVA_HOME="$best_home"
  export PATH="$JAVA_HOME/bin:$PATH"
  ok "jdk $best_major (JAVA_HOME=$JAVA_HOME)"
}

# The wrapper is the only Maven this repo has — `mvn` is not installed (it is a
# shell alias in some setups, which a script never inherits).
ensure_mvnw() {
  [ -f "$JAVA_DIR/mvnw" ] || die "$JAVA_DIR/mvnw is missing — is the checkout complete?"
  [ -x "$JAVA_DIR/mvnw" ] || { warn "mvnw was not executable — fixing"; chmod +x "$JAVA_DIR/mvnw"; }
  ok "maven wrapper $(sed -n 's/.*apache-maven-\([0-9.]*\)-bin\.zip/\1/p' "$JAVA_DIR/.mvn/wrapper/maven-wrapper.properties" 2>/dev/null | head -1)"
}

# ------------------------------------------------------- shared parsing -----

# Defaults every script shares; each script may add its own flags on top.
SKIP_INSTALL="no"
FROZEN="yes"
AUTO_INSTALL="yes"
TARGET="all"      # all | ts | java

# Returns 0 if it consumed the argument, 1 if the caller should handle it.
parse_common_flag() {
  case "$1" in
    --ts|--ts-only)     TARGET="ts" ;;
    --java|--java-only) TARGET="java" ;;
    --all)              TARGET="all" ;;
    --skip-install)     SKIP_INSTALL="yes" ;;
    --no-frozen)        FROZEN="no" ;;
    --no-auto-install)  AUTO_INSTALL="no" ;;
    *) return 1 ;;
  esac
  return 0
}

wants_ts()   { [ "$TARGET" = "all" ] || [ "$TARGET" = "ts" ]; }
wants_java() { [ "$TARGET" = "all" ] || [ "$TARGET" = "java" ]; }
