---
title: Artifacts
linkTitle: Artifacts
weight: 5
---

The files codegraph writes that are not the interchange model. Each is a **derived** model: a second model built from the first, self-describing, deterministic, and never mistakable for a `model.jsonl` — the `kind` field says what it is.

| Artifact | Written by | `kind` / `artifact` | Shape |
|---|---|---|---|
| [`city.json`](/docs/reference/artifacts/city-json/) | [`city`](/docs/reference/cli/city/), [`replay`](/docs/reference/cli/replay/), [`history --city`](/docs/reference/cli/history/) | `codegraph.city/1` | one JSON document |
| [`navigator.json`](/docs/reference/artifacts/navigator-json/) | [`navigator`](/docs/reference/cli/navigator/) | `codegraph.navigator/1` | one JSON document |
| [`history.jsonl`](/docs/reference/artifacts/history-jsonl/) | [`scm`](/docs/reference/cli/scm/) | `"artifact": "history"` | JSONL, section-ordered |
| [`domain-facts.json`](/docs/reference/artifacts/domain-facts/) | [`domain-facts`](/docs/reference/cli/domain-facts/) | `codegraph.domainFacts/1` | one JSON document |
| [`<model>.insights.jsonl`](/docs/reference/artifacts/insights-jsonl/) | [`explain`](/docs/reference/cli/explain/) | `codegraph.insights/1` | JSONL, header/records/trailer |

Two more files are not artifacts in this sense: [`model.jsonl`](/docs/reference/model-jsonl/) is the interchange contract, and [`model.db`](/docs/reference/model-db/) is a derived, disposable cache.

## What every artifact carries

- **Its own kind.** A consumer can refuse a file that is not what it expected.
- **Its view.** A city, a navigator model or a set of dossiers computed under `--internal-only` or `--declared-only` states that view in the artifact, because a coupling number without its view is not a fact. The `ViewDescriptor` is `{name, filters}`.
- **Its corpus.** A display name and the model roots the artifact was built from, verbatim.
- **Its diagnostics.** Whatever the transform dropped, could not place, or could not measure — counted, and named where naming is affordable.

## Determinism

Two runs over one unchanged model produce byte-identical artifacts. Arrays are sorted (never `Set`s, which do not survive `JSON.stringify`), dimensions are rounded to a fixed number of decimals, and no artifact body carries a timestamp. The one exception is stated where it applies: the `insights.jsonl` trailer carries `generatedAt`, and nothing else in that file does.
