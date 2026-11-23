---
name: query
description: Answer a question about a codebase with one SQL query over its codegraph model, and save the query with its rows so the answer can be cited and checked. Use when someone asks something the discovery steps' tables do not answer — "which classes implement this interface", "what calls this method", "which modules use this library", "how many public methods have no caller", "list every type annotated with X" — or wants a number about the code they can trust and re-run. Needs a model already extracted (step 1 of the discovery walk). Read-only, free, no model call.
argument-hint: "<path-to-repository> <question>"
---

# Query: one question, one saved `SELECT`

A question about the code becomes **one** read-only SQL statement over the
model, saved in the workspace with its rows. A claim that rests on it cites
the file; anyone can run it again.

**Arguments:** `$ARGUMENTS` — the repository's path, then the question in
words.

**Cost.** Free. `codegraph query` reads the model's store and writes nothing
to it; no model call, nothing leaves the machine.

In the commands below `$REPO` is the repository's absolute path, `$WS` is
`$REPO/.codegraph` and `$MODEL` is the model the question is about,
`$WS/main.jsonl` unless `discovery.json` names another root.

## 1. Find the model

Read `$WS/discovery.json` and take the model from `corpus.roots`. No
workspace, or no model: the question cannot be answered yet. Say so and offer
step 1 (`/codegraph:discover-1-structure`), which extracts it in seconds.

Begin every command with the line that puts the tools on the path:

```bash
[ -n "${CODEGRAPH_HOME:-}" ] && PATH="$CODEGRAPH_HOME/bin:$PATH"
```

## 2. Learn the tables — with `SELECT`s

Do not write a query from memory of the schema: read it. All three are
queries themselves.

```bash
codegraph query --views
codegraph query "$MODEL" "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name"
codegraph query "$MODEL" "SELECT name, type FROM pragma_table_info('entity')"
```

- `--views` prints the two helper views every query can use: `node`, one row
  per entity with the id every report prints (`id`), its `kind`, `name`,
  `is_stub`, its module (`module_ref`) and its container (`parent_ref`); and
  `dep`, one row per edge with `from_ref`, `to_ref`, `kind`, `provenance`,
  `file` and `line`.
- The tables behind them: `entity`, `edge`, `kind`, `edge_kind`, `provenance`,
  `file`, `entity_metric` (`entity_id`, `key`, `value`), `trait`, `trait_set`,
  `trait_set_member`, `meta`.
- The shipped queries are worked examples: read one that is close to the
  question in `${CLAUDE_PLUGIN_ROOT}/queries/` before writing your own.

## 3. Write the statement

One statement, beginning with `SELECT` or `WITH`. Anything else is refused.

- **Ask for a type by its trait, never by a list of kinds.** "A type" is a
  `class` in Java, a `module` in Elixir, a `typeAlias` in TypeScript; what
  they share is the trait `TType`:

  ```sql
  SELECT n.id
    FROM node n
   WHERE n.trait_set_id IN (SELECT m.trait_set_id
                              FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
                             WHERE t.name = 'TType');
  ```

  The same holds for a module (`TModule`) and an operation (`TInvocable`).
  `${CLAUDE_PLUGIN_ROOT}/references/capabilities.md` says which kinds carry
  which, per language.
- **Bind values, never splice them.** An id holds parentheses, commas and
  sometimes quotes. Write `:id` in the statement and pass
  `--param id='java:com.acme.order/Order.discount(int)'`. A list is a JSON
  array read with `json_each(:names)`.
- **Build on a saved result with `--param-file`.** `--param-file rows=FILE`
  binds `:rows` to the whole text of a file: `json_each(:rows, '$.rows')`
  reads the rows a `--json` run saved, each an array
  (`json_extract(r.value, '$[0]')` is its first column). Never retype a list
  of ids on a command line.
- **Never join `node` on its `id`.** `node.id` is built for every entity as
  the view is read, so nothing indexes it: `WHERE n.id = :id` is one pass over
  the model, and `JOIN node n ON n.id = list.id` is one pass per row of the
  list. Turn it around: `WHERE n.id IN (SELECT id FROM list)`.
- **Say what you mean about stubs.** `is_stub IS 1` is what the code
  references and does not declare; `IS NOT 1` is the code itself. A count
  that mixes them answers neither question.
- **Say what you mean about provenance.** `dep.provenance = 'declared'` is
  what is written; without that filter the rows include inferences, and the
  answer is as weak as the weakest row.
- **Order it, and break ties**, so two runs print the same rows: end the
  `ORDER BY` with the id.
- **Absent is not zero.** A measure lives in `entity_metric` only where
  something was measured: an inner join skips the rest, and the answer must
  say so.

## 4. Save it, run it, save its rows

Number it after the last file in `$WS/queries/`, name it for the question,
and begin the file with the question as a comment:

```sql
-- question: which types implement Priceable?
SELECT …;
```

```bash
codegraph query "$MODEL" --file "$WS/queries/NN-name.sql" --json > "$WS/queries/NN-name.json"
```

`--param name=value` once per parameter; `--all` when the fifty rows shown by
default are not enough; `--csv` for a spreadsheet.

A statement SQLite refuses exits 2 with SQLite's own message: fix the
statement and run it again. **Never reach for another database client or a
script of your own**: an answer obtained that way is not checkable by the
person, and is not the walk's answer.

## 5. Check it before you trust it

A new query is a hypothesis. Before giving its answer:

- run it on a case whose answer you know — an entity you have read, a count
  already in `queries/01-summary.json`;
- if it returns **zero rows**, that is "this query found none", not "there
  are none". Loosen it once to see that it can find something; say what the
  language does not record (`capabilities.md`) when that is the reason;
- if it counts, check the total against a count made another way.

## 6. Answer

Show the three to five rows that answer, and the total. Say the kind of
knowledge the answer is (`${CLAUDE_PLUGIN_ROOT}/references/evidence.md`):
`declared` when it rests only on written facts, the weakest provenance
otherwise. Give the file: `queries/NN-name.sql`, with its rows beside it.

If the answer is a finding of a step, the step writes it to `discovery.json`
with that file as its anchor. On its own, the query and its rows are the
record: add one line to `$WS/NOTEBOOK.md` with the question, the answer and
the file.
