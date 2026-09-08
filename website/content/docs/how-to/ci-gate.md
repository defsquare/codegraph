---
title: Gate a CI pipeline on model quality
linkTitle: Gate a CI pipeline
weight: 3
---

Codegraph separates a broken tool from a broken model in its exit codes, so a
pipeline can fail on findings about your code without failing on a bug in
codegraph. This guide wires `validate` and `analyze --report cycles` into a job
and keeps the model as an artifact.

**Before you start:** a job that can produce a `model.jsonl` (a JDK and the
extractor jar for Java) and the `codegraph` CLI on `PATH`.

## The exit codes the gate reads

| Code | Meaning | What the job should do |
|---|---|---|
| `0` | success | pass |
| `1` | an internal error — a bug in codegraph | fail loudly; it is not about your code |
| `2` | a usage error — a bad command line | fail loudly |
| `3` | findings — the tool worked, the input did not | this is the gate |

## Gate on conformance

1. Extract, then validate. `validate` exits `3` when the model has findings and
   prints them to `stdout`.

   ```bash
   java -jar codegraph-java.jar --src src/main/java --out model.jsonl --progress plain
   codegraph validate model.jsonl
   ```

   A truncated or half-written model is caught here, not three commands later:

   ```text
   unreadable as a model (1):
     model.jsonl:
       not a valid model.jsonl: no eof record — the file is truncated, or the writer died mid-run

   FAILED — 1 file that is not a model.
   ```

2. Keep the machine-readable form if a later job consumes it:

   ```bash
   codegraph validate model.jsonl --json > validate.json
   ```

   The object carries `ok`, `subject`, `counts.byRule` (`closure`,
   `self-reference`, `provenance`, `candidates`, `profile`, `anchor`,
   `duplicate-id`) and `findings`.

## Gate on cycles

`analyze --report cycles` exits `3` when the folded graph has any strongly
connected component. **Pick the level deliberately** — it decides what you are
gating on:

```bash
codegraph analyze model.jsonl --report cycles                 # module level (default)
codegraph analyze model.jsonl --report cycles --level type    # class level
```

On the reference fixture the module level is clean (exit `0`) and the type level
is not:

```text
2 dependency cycle(s) at type level under view all — exiting 3 (findings).
…
tangle: 40.0% overall — feedback weight 2 of 5 cyclic references (minimum feedback set)
```

If the gate should judge what the code says and not what codegraph inferred,
add `--declared-only`; if external types should not count, add `--internal-only`.
Every report names the view it ran under, so the log always says which numbers
these are.

For a threshold rather than a boolean, read the JSON: `componentCount` and
`tangle.metric` are the two numbers worth a budget.

```bash
codegraph analyze model.jsonl --report cycles --level type --json > cycles.json
```

## Put it in a GitLab job

```yaml
model:
  stage: check
  script:
    - java -jar codegraph-java.jar --src src/main/java --out model.jsonl --progress plain
    - codegraph validate model.jsonl
    - codegraph analyze model.jsonl --report cycles --json > cycles.json
  artifacts:
    when: always
    paths: [model.jsonl, cycles.json]
```

**If a finding should warn rather than block, then allow exactly code 3** — never
a blanket `allow_failure: true`, which would also swallow a usage error:

```yaml
  allow_failure:
    exit_codes: [3]
```

{{< callout type="info" >}}
Codegraph writes byte-identical output for identical input, so committing the
model — or diffing the artifact against the previous pipeline's — is a real
signal. See [Compare two models of one corpus](/docs/how-to/compare-snapshots/).
{{< /callout >}}

## Related

- [Exit codes reference](/docs/reference/exit-codes/)
- [`codegraph validate`](/docs/reference/cli/validate/)
- [`codegraph analyze`](/docs/reference/cli/analyze/)
- [Get a facts-only or internal-only answer](/docs/how-to/facts-only-view/)
