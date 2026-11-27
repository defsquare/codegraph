# The workspace and the state

What a step learns is written to disk, in one hidden directory at the root of
the analyzed repository. Nothing the walk needs later lives only in the
conversation: a session can end at any beat and another can resume from the
files alone.

## The workspace

`$WS` is `<repository>/.codegraph/`.

```
.codegraph/
├── discovery.json        the state: yours to write, at the end of every step
├── NOTEBOOK.md           the log: one entry per step, appended (evidence.md)
├── REPORT.md             the summary, rewritten at every stop (report.md)
├── <root>.jsonl          one model per source root (main.jsonl, test.jsonl)
├── <root>.db             its store: a cache codegraph builds and rebuilds
├── <root>.extract.log    what the extractor said, the resolution summary included
├── history.jsonl         the mined git history (step 3), and history.log
├── <root>.history-metrics.jsonl   the history side-car the city reads (step 3)
├── reports/              saved reports: cycles, coupling, the module map, the
│                         history reports — authors.json is the one file with names
└── queries/              every query run: NN-<name>.sql and its rows, NN-<name>.json;
                          11-stack.json is the table of names step 4 ran with
```

Later steps add their own files here: step 5 the store `<root>.insights.db`
and its export `<root>.insights.jsonl`, step 6 `<root>.domain-facts.json`;
each step's file names them. The Specy skill of step 6 writes its model in
`specy/` at the repository root, never here: that directory is the person's,
to commit or to delete.

Three rules about this directory:

- **It is hidden from git without touching a tracked file.** When you create
  it, add `.codegraph/` to the repository's `info/exclude`, never to
  `.gitignore`: the person's `git status` must stay what it was. The step
  that creates the workspace gives the commands. Outside a git repository
  the directory is the same and there is nothing to exclude.
- **You write nowhere else** in the repository, and nothing outside it.
- **Every query and report is saved before it is shown.** A finding cites the
  saved file, so the file must exist first.

## discovery.json

The schema is `discovery.schema.json`, beside this file; the examples in
`examples/` show a walk that has just started, one after step 1, one after
a tour and one that went to the end. In short:

| Field | Holds |
|---|---|
| `kind` | `codegraph.discovery/1` |
| `codegraph` | the `codegraph --version` that last wrote the file |
| `intake` | the purpose, the time at hand, the answer about a second provider — each only if it was given |
| `corpus` | the repository path, the commit extracted, shallow or not, the language census, the source roots and their models, the excluded paths |
| `steps` | per step started: `status`, the `commit` it ran at, the day, and `findings` |
| `questions` | what no file answers: the text, the step that raised it, who could answer, open or answered |
| `spend` | per paid run: day, step, provider, model, calls, dollars — as the command reported them (`codegraph insights … --runs`) |
| `taught` | the terms already defined to this person |

`steps` uses the page names as keys: `structure`, `boundaries`, `activity`,
`stimuli`, `meaning`, `domain`. A step's `status` is `todo` (started, nothing
written), `done`, `partial` (stopped before the end: say in the notebook what
is missing) or `skipped` (the person chose not to run it).

`findings` holds what the step's documentation page lists under "Write down",
one key per item. Each key holds a list: one finding per model the step ran
on, or one alone when the finding is about the repository. A finding is
`value`, `kind`, `anchor`, and optionally `root` and `note`; an explanation
also says who read the code, in `origin` (`evidence.md`).

## Reading and writing it

- **Read it first**, with your file tool, not through `python` or `jq`. A
  step begins by reading `discovery.json`; a session begins by reading it and
  saying where the walk stands.
- **Re-read it before you write.** Read the file again immediately before each
  write, change only your step's part, and write the whole file back. Never
  write it from what you remember of it.
- **Write it with your own file tool, the whole file.** Not with `jq`, `sed`
  or a pipeline of shell commands: none of them is on every machine, and one
  quoting slip leaves a state nobody can read. Then read it back once, with
  the same tool: it parses or it does not, and no interpreter is needed to
  see which.
- **Write it valid.** Unknown fields are refused by the schema; do not invent
  one. If you need to record something the schema has no place for, it belongs
  in the notebook.
- **Never delete what a person said.** An excluded path, an answer, a `said`
  finding stay, even when a step is run again.
- **Never write a person's name.** Who wrote a file is a share, a count and a
  date in the state; a `said` anchor names a role. The names the history
  holds stay in `reports/authors.json`.

## When the code has moved

`corpus.commit` is the commit the models describe. At the start of a session,
compare it with the repository's `HEAD`:

```bash
git -C "$REPO" rev-parse HEAD
git -C "$REPO" rev-list --count "$COMMIT..HEAD"
git -C "$REPO" diff --name-only "$COMMIT" HEAD | wc -l
```

If they differ, say so before showing any anchor: by how many commits, and how
many files changed. Then offer to run the free steps again, which takes
seconds. A line number in an old finding may point somewhere else now; a
finding is true at its step's `commit` and is shown with it. What step 5 paid
for is not lost by re-extracting: its records are matched by content, and a
second run pays only for what changed.

## Starting cold

No `.codegraph/` yet: the walk has not started here. Create the workspace and
write the first `discovery.json` with `corpus` filled in, `steps` empty,
`questions`, `spend` and `taught` empty lists.

`.codegraph/` exists and `discovery.json` does not, or does not parse: do not
guess. Say what you found, keep the files, and ask whether to start a new
state beside the models already there.
