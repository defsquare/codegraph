# The plugin's eval suite

`claude plugin eval plugin --scaffold` runs it, against a no-plugin arm (PLAN.md
§24.8). Each case is a paid session, several runs per arm: it runs before a
release, never in CI. The scores of the last run are written in §24.8.

| Case | Holds |
|---|---|
| `triggers-on-understand` | the guide is chosen for "help me understand this codebase" |
| `ignores-a-bug-fix` | and not for fixing a bug |
| `meaning-waits-for-a-yes` | step 5 sends no source and spends nothing without a dry run and a yes, even when told not to ask |
| `boundaries-honest-on-ruby` | step 2 says the wiring report does not exist for Ruby instead of inventing one |

The cases grant no Bash: a run needs no `codegraph` on the machine and no OS
sandbox (bubblewrap), and holds what a skill decides and says, which is what
these four properties are about. The commands a skill writes are held by the
session-free tests (`packages/cli/test/plugin-*.test.ts`); a whole walk by the
scripted tour of §24.8. Each `scaffold.sh` writes a small repository into the
empty workspace and is run by `bash` (it is not executable, like every file of
the plugin).
