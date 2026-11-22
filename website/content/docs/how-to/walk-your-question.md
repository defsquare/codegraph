---
title: Ask your own question of the code
linkTitle: Your own question
weight: 11
---

`codegraph explain` asks one question of every unit — what is this, in a domain-modelling vocabulary? `codegraph walk` asks yours: where a transaction starts, what an audited method records, which code builds SQL from its input. It walks the same way, bottom-up — leaf operations, their callers, the types that own them, the modules — and shows each prompt what was already answered about the unit's dependencies, so the question is asked of code whose collaborators have been read. You choose the question, which units are asked, and what each answer must contain.

**Before you start:** a `model.jsonl` and the source tree its anchors point into. `--dry-run` and `--estimate` make no call and need no key; a run needs a [provider](/docs/how-to/explain-cost/#choose-a-provider), as `explain` does. Every command below runs from the repository root on the Java fixture.

## Ask one question of some of the code

```bash
codegraph walk fixtures/java/expected/model.jsonl --src fixtures/java/src \
  --prompt "Which of these is audited, and what does the audit record?" \
  --include 'edge:annotationUse>name:Audited' --dry-run
```

```text
walk plan (adhoc): 77 units in 8 layers
  operation     57 units      2 calls ~1122 prompt tokens
  type          17 units      0 calls ~0 prompt tokens
  module         3 units      0 calls ~0 prompt tokens
  statuses: llm 2, template 0, reuse 0, skip-scope 75, skip-budget 0
  selection: 1 dependency of the selection is not walked (1 unselected); without a record, shown as NOT EXPLAINED
  --closure dependencies adds 2 units (operation 2, type 0, module 0)
  models: openai/gpt-5.6-luna (operations), openai/gpt-5.6-luna (types, modules); depth 1
  total: 2 calls, ~1122 prompt tokens in, ~1000 completion tokens out
```

`--prompt` is the task, asked at every level. `--include` takes one [selector term](/docs/reference/walk-definition/#selectors) — here "writes an annotation use whose target is named `Audited`" — and a unit is asked when its member, the member's nearest type or its nearest module matches. Two operations do. The other 75 units are `skip-scope`: never called, and shown to the units above them as NOT EXPLAINED.

With no `--include`, every unit is asked except the trivial members (getters, setters, `equals`…), which a walk skips unless its definition says `"trivial": "ask"`. The walk's name is `adhoc`, and its answers go to `fixtures/java/expected/model.adhoc.walk.db` and its export `model.adhoc.walk.jsonl` — never to explain's store.

Some terms to start from:

```bash
codegraph walk fixtures/java/expected/model.jsonl --src fixtures/java/src --prompt "Say which state this code changes." --include 'module:com.acme.order**' --exclude 'file:**/legacy/**' --dry-run
codegraph walk fixtures/java/expected/model.jsonl --src fixtures/java/src --prompt "Say which state this code changes." --include 'edge:invocation>module:java.io**' --levels operation --dry-run
codegraph walk fixtures/java/expected/model.jsonl --src fixtures/java/src --prompt "Say which state this code changes." --include 'edge-in:inheritance' --levels type --dry-run
```

`module:com.acme.order**` is the package and its sub-packages (`*` stays inside one segment); `--exclude` always wins; `--levels` keeps only the levels named. Repeat `--include` for several terms: a unit is asked when any of them matches.

## Give the selection what it leans on

The `selection:` line says what the asked units depend on that is not asked: those dependencies reach the prompts as NOT EXPLAINED. `--closure dependencies` asks them too, transitively; `--closure containers` asks the types and modules above the selection; `--closure all` both.

```bash
codegraph walk fixtures/java/expected/model.jsonl --src fixtures/java/src \
  --prompt "Which of these is audited, and what does the audit record?" \
  --include 'edge:annotationUse>name:Audited' --closure dependencies --estimate
```

```text
walk estimate (adhoc): fixtures/java/expected/model.jsonl
  units: 77 (operation 57, type 17, module 3) in 8 layers
  calls: 4 (template 0, reuse 0, skipped 73)
  models: openai/gpt-5.6-luna (operations), openai/gpt-5.6-luna (types, modules); depth 1

  level        calls   input tokens  output tokens
  operation        4          2 182          2 000
  type             0              0              0
  module           0              0              0
  total            4          2 182          2 000

  cost: pass --price-in USD --price-out USD (per million tokens) for a figure
  input ≈ rendered prompts at 4 characters per token; output ≈ measured on a live run: operation 500, type 620 tokens per block asked for (sonnet through claude-code, on a walk that declares no field: declared fields add to it; no module was measured, it takes the type's figure).
  not included: repair re-asks, rate-limit retries. Records already in the side-car are reused, not re-sent.
```

Two plus the two it adds: four calls, and nothing left unwalked. The output column counts 500 tokens per operation block and 620 per type block: the means of one live run of a defined walk (Spring PetClinic, `sonnet` through Claude Code, a walk that declares no answer field). A module was not measured and takes the type's figure; the fields you declare lengthen an answer and are not counted. On that run the estimate was 12.4 % above the billed input and, before these figures replaced a flat 500, 5.3 % below the billed output — the type blocks 19.3 % below. One run, on one corpus, with one model and one question, is the whole basis of these figures.

## Write the question down

A question worth asking twice belongs in a file. Start from the default definition:

```bash
codegraph walk --print-definition > audit.json
```

and edit it. A [walk definition](/docs/reference/walk-definition/) can give each level its own task, add instructions to every prompt and to the prompts of chosen entities, and declare the fields each answer must carry:

```json
{
  "kind": "codegraph.walk/1",
  "name": "audit",
  "version": "1",
  "levels": ["operation", "type"],
  "select": { "edge": { "kind": "annotationUse", "to": { "name": "Audited" } } },
  "closure": "containers",
  "prompt": {
    "task": {
      "operation": "@Audited marks a method whose calls must reach the audit log. Say what a call of this operation would record, and whether anything in its source or its callees sends it to a log at all.",
      "type": "Say which of this type's operations are audited, and whether its state can change outside them."
    },
    "instructions": "Answer in English. Quote the annotation's value when it matters.",
    "entities": [
      { "select": { "name": "Reporting" }, "instructions": "Reporting runs monthly: say what max returns on an empty list." }
    ]
  },
  "answer": {
    "label": "logged",
    "fields": {
      "operation": { "logged": { "enum": ["yes", "no", "unclear"] }, "recorded": "string[]" },
      "type": { "unaudited": { "list": { "operation": "string", "why": "string" } } }
    }
  }
}
```

- `name` gives the walk its own store, `model.audit.walk.db`: two definitions never share one.
- `select` is the JSON form of the term above; `closure: containers` adds `Order` and `Reporting`, the types above the two operations (the module is outside `levels`).
- `prompt.entities` adds a line to the prompt of every member its selector selects — the type `Reporting` and, through their nearest type, its operations — and nowhere else.
- Every answer carries `answer` (the response in full), `description` (at most 60 words, **the one line the units above it are shown**) and `confidence`, plus the declared fields. `label` puts `logged: yes` beside an operation's description wherever a type's prompt quotes it.

```bash
codegraph walk fixtures/java/expected/model.jsonl --src fixtures/java/src --walk audit.json --dry-run
```

```text
walk plan (audit): 77 units in 8 layers
  operation     57 units      2 calls ~1250 prompt tokens
  type          17 units      2 calls ~1792 prompt tokens
  module         3 units      0 calls ~0 prompt tokens
  statuses: llm 4, template 0, reuse 0, skip-scope 73, skip-budget 0
  selection: 13 dependencies of the selection are not walked (12 unselected, 1 trivial, skipped); without a record, shown as NOT EXPLAINED
  --closure all adds 24 units (operation 19, type 5, module 0)
  models: openai/gpt-5.6-luna (operations), openai/gpt-5.6-luna (types, modules); depth 1
  total: 4 calls, ~3042 prompt tokens in, ~2240 completion tokens out
```

A flag still wins over the file's key — `--walk audit.json --levels operation` asks the two operations alone — and what is recorded is the definition with the flag folded in. A file with a fault is refused before anything is read, every fault with its path; see [Faults](/docs/reference/walk-definition/#faults).

## Run it

```bash
codegraph walk fixtures/java/expected/model.jsonl --src fixtures/java/src --walk audit.json --provider claude-code
```

The run prints its estimate on stderr and asks `[y/N]` before the first call; `--yes` skips the question, and without a terminal it is required. Each finished unit is committed to the store as it arrives, so a killed run loses nothing it paid for, and the side-car is written when the run ends. A second run with the same definition and model plans 0 calls: every answer's fingerprint still matches. A unit that could not be answered leaves a failure record, and `--retry-failed` redoes it with its direct dependents.

## Read the answers

```bash
codegraph insights fixtures/java/expected/model.jsonl --walk audit                 # the summary: records, models, what is owed, the spend
codegraph insights fixtures/java/expected/model.jsonl --walk audit --level type    # one line per record: id, level, confidence, description
codegraph insights fixtures/java/expected/model.jsonl --walk audit --id 'java:com.acme.order/Reporting'   # one answer, field by field
codegraph serve fixtures/java/expected/model.jsonl --insights fixtures/java/expected/model.audit.walk.db
```

`insights --walk audit` reads the walk's store and nothing else. `--id` prints `answer:`, each declared field by its name, and `description:`; a list prints one `- item` per line, and `—` stands for `null` or an empty value. Explain's questions about concepts and words (`--concept`, `--word`, `--glossary`…) answer `none` on a walk's store: a walk's blocks carry neither.

`serve --insights` puts the walk's store behind the Navigate tab's panel: a selected type or module shows, in the page's inference colour, the badge *LLM answer*, the walk's name, the model and its claimed confidence, then the answer, every field by its declared name, and the description. The panel reads one store per page — explain's or one walk's.

## Change the question

Edit the task, the instructions or the version and run again: the units whose prompts changed are asked again, and the first line of the plan, the estimate and the confirmation says how many records that replaces, before anything is spent:

```text
note: the definition changed since this store was written: these 68 units are asked again and their records REPLACED; --name OTHER keeps both.
```

Declined, nothing is written. Change the answer fields and the store is refused instead — a store holds the records of one answer shape — so give the new shape a new name (`--name audit-v2`, or a new `name` in the file); the old answers stay readable under the old one.

## Or customize explain

`explain` takes the same selection flags and instructions, and keeps its own question, blocks and store:

```bash
codegraph explain fixtures/java/expected/model.jsonl --src fixtures/java/src --exclude 'module:com.acme.order.legacy' --instructions "Answer in French." --dry-run
codegraph explain fixtures/java/expected/model.jsonl --src fixtures/java/src --walk explain-custom.json --dry-run
```

`explain-custom.json` is the file shown in [Customizing explain with a file](/docs/reference/walk-definition/#customizing-explain-with-a-file): a file handed to `explain --walk` may set the selection, the context and the instructions — never a task or answer fields. A flag still replaces the file's key. A unit no instruction reaches keeps its fingerprint, so its explanation is reused.

## Related

- [`codegraph walk`](/docs/reference/cli/walk/) — every flag, the files, the JSON kinds
- [Walk definitions and selectors](/docs/reference/walk-definition/) — the format, the selector grammar, what a selection means for the walk
- [`codegraph insights`](/docs/reference/cli/insights/) — reading a store
- [Estimate, cap and scope an explain run](/docs/how-to/explain-cost/) — providers, models per level, the request rate
- [Explaining bottom-up](/docs/explanation/explaining-bottom-up/) — why the walk is ordered this way
