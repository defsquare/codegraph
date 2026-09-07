---
title: Exit codes
linkTitle: Exit codes
weight: 10
---

Four codes. CI must be able to tell "the tool broke" from "the model is bad", so those two are never the same number.

| Code | Name | Meaning |
|---|---|---|
| `0` | `OK` | the command did what it was asked; nothing to report |
| `1` | `INTERNAL` | an unexpected throw — a bug in codegraph itself |
| `2` | `USAGE` | unknown command or flag, missing argument, unreadable file |
| `3` | `FINDINGS` | the tool worked perfectly; the INPUT is invalid, or a property failed |

Every command's `--help` ends with the same line:

```
exit codes: 0 ok · 1 internal error (a bug) · 2 usage error · 3 findings.
```

## The findings contract

**A finding is a statement about the input, never about the tool.** A model that violates its profile, a graph that contains a cycle, a revision the extractor could not process — the analysis succeeded and produced a correct answer; the answer is bad news. Conflating `1` and `3` would make a crash look like a bad model and a bad model look like a crash.

**Findings are not thrown.** A usage mistake raises and aborts; a finding is a normal result the command reports on stderr and returns `3` for. The artifact is still written: `export`, `city`, `navigator` and `domain-facts` all produce their output and exit `3`, because a partial picture with its diagnostics stated is more useful than no picture.

**The command says so before it exits.** `analyze --report cycles` prints the reason on stderr:

```
2 dependency cycle(s) at type level under view all — exiting 3 (findings).
```

**A usage error names what would have been valid.** An error that only says "no" costs another round trip:

```
codegraph: unknown option '--no-cache' for 'codegraph city'
Valid options for 'codegraph city': --height METRIC, --height-scale <linear|sqrt|log>, …
```

## What produces `3`, per command

| Command | Exits `3` when |
|---|---|
| [`validate`](/reference/cli/validate/) | any model has findings, or the load was not clean |
| [`analyze`](/reference/cli/analyze/) | the load was not clean; and for `--report cycles`, whenever any strongly connected component exists |
| [`import`](/reference/cli/import/) | the load was not clean; the store is still written |
| [`export`](/reference/cli/export/) | the load was not clean; the artifact is still written |
| [`city`](/reference/cli/city/) | the load was not clean; the city is still built |
| [`navigator`](/reference/cli/navigator/) | the load was not clean; the artifact is still written |
| [`domain-facts`](/reference/cli/domain-facts/) | the load was not clean; the artifact is still written |
| [`explain`](/reference/cli/explain/) | the load was not clean, or any unit failed to be explained |
| [`snapshots`](/reference/cli/snapshots/) | any sampled revision failed to extract; the successful frames stay in the store |
| [`history`](/reference/cli/history/) | the input file is not a `history.jsonl` |
| [`scm`](/reference/cli/scm/), [`timeline`](/reference/cli/timeline/), [`replay`](/reference/cli/replay/), [`profiles`](/reference/cli/profiles/) | never |

"The load was not clean" means the union the command read produced diagnostics: a schema error, a closure violation, a self-edge, a profile violation, or a conflicting redeclaration across models. Run [`validate`](/reference/cli/validate/) on the same paths for the detail.

## In CI

A job gating on model quality checks for exactly `3`:

```bash
codegraph validate model.jsonl                # 0 or 3; anything else is a tool problem
codegraph analyze model.jsonl --report cycles # 3 when any cycle exists
```

Both fail the job on `3` under a shell with `set -e`. To treat a finding as a warning instead, capture the code:

```bash
set +e; codegraph analyze model.jsonl --report cycles; code=$?; set -e
case $code in
  0) ;;                                  # clean
  3) echo "cycles reported" ;;           # a finding: the analysis worked
  *) exit "$code" ;;                     # 1 or 2: the tool or the invocation
esac
```

A job that must distinguish the two treats `1` as an infrastructure failure to retry and `3` as a result to report.
