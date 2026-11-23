# The rhythm of a step

Every step of the walk has the same seven beats. A step's own file says what
goes in each; this file says how a beat is played. The person is learning their
codebase, not reading yours: at each beat, less is more.

## The seven beats

1. **Frame.** One short paragraph: the question this step answers, what it
   costs (time, and money if any), and what the person will hold when it ends.
   Then start. Do not ask permission to run a free step.

2. **Run.** Every command writes to a file in the workspace. Never paste a
   whole report into the conversation: a table of two thousand rows teaches
   nothing and pushes what matters out of sight. Say in one line what is
   running and where its output goes. An exit code of 3 from `codegraph` means
   *findings*, not failure: `validate` found issues, or `analyze --report
   cycles` found a cycle. Read the output; do not retry. Any other failure is
   reported, with its message, and never replaced: no other database client,
   no other tool, no script of your own. An answer obtained by a workaround is
   not the method's answer.

   To read a saved result, use your file-reading tool, or run the same
   command again without `--json` and with `--top 5` or `--limit 5`: its
   table is made to be read. Do not write a script to pick rows out of a
   file — no `python`, no `jq`: neither is on every machine, and a number a
   script computed is in no saved file.

3. **Show.** Three to five rows of each result, chosen because they matter:
   the top of a ranking, the place where a curve breaks, the row that
   contradicts what the person expected. And one picture: the command of the
   step, on `127.0.0.1`, with its URL. If you can take a screenshot of the
   page, read it before you describe it; if you cannot, describe from the
   reports and say that you have not seen the picture.

4. **Read.** Say how to read what is shown, with the rule the documentation
   page gives and no other. Define a term the first time it is used, in one
   sentence from `words.md`, and add it to `taught` in the state: a term
   defined once is not defined again.

5. **Ask.** One to three questions that only a person can answer; the step
   file lists them. Ask them together, and make "I don't know" and "skip" easy
   answers. A question that is skipped is not lost: it goes to `questions` in
   the state, with who could answer it.

6. **Write.** Re-read `discovery.json`, then write: the step's findings, each
   with its kind and its anchor (`evidence.md`); the questions; the step's
   status and the commit it ran at. Append the entry to `NOTEBOOK.md`. Then
   rewrite `REPORT.md` from the state (`report.md`). Write before the gate,
   not after: if the session ends at the gate, nothing is lost, and the
   report does not describe an older walk than the state does.

7. **Gate.** Two lines: what was found, and what the next step costs. Then
   four choices, always the same: **continue** to the next step, **go deeper**
   here, **skip** the next step, or **stop**. Wait for the answer.

## The tour

`--tour` is steps 1 to 3 with no question asked, for someone who wants the
terrain before deciding anything (`intake.time` is `tour`). The same steps,
played differently:

- **Frame:** one line per step.
- **Run:** unchanged. No page is served: nobody is watching. The brief gives
  the three `serve` commands instead.
- **Show** and **Read:** not per step. They are the brief, once, at the end.
- **Ask:** nothing is asked. Each question the step would have asked is
  written to `questions`, open, with who could answer. Each thing you would
  have asked a person to confirm is written as the guess it is: a source root
  with `guessed: true`, an exclusion with `by: "agent"`, a history window
  chosen by the page's rule and named in the finding's `note`.
- **Write:** the state and the notebook after each step; the report once,
  after step 3.
- **Gate:** none between the steps. A step that cannot run is written
  `skipped` with its reason, and the tour goes on.

After step 3, write `REPORT.md` (`report.md`) and give the brief in the
conversation: its "In brief" section; the commands of the three pictures; the
questions collected; and **what the tour could not do** — for this language
(`capabilities.md`), for this repository (no history, a shallow clone, a
language with no extractor, an extractor that is not installed), and every
guess it made. Then ask step 3's gate question, once.

## Stopping is a success

Each step leaves something a person can use on its own: after step 1 the
terrain and its outliers, after step 3 the hotspot shortlist, after step 4 a
reading order, after step 5 a glossary, after step 6 a model. Say so at the
gate. A person who stops after step 3 has not failed to finish; they have what
they came for. Never press for the next step, and never run a step that costs
money because the walk "is nearly done".

At every stop, rewrite `REPORT.md` from the state (`report.md`) and say where
it is.

## Going deeper

"Go deeper" means the person has a question the step's tables do not answer.
Answer it with a query: write ONE `SELECT`, save it in the workspace as
`queries/NN-<name>.sql`, run it with `codegraph query`, save its rows beside
it as `queries/NN-<name>.json`, and show the rows that answer. A claim that
rests on it cites the file. Then return to the gate.

## One page, one server

At most one `codegraph serve` runs per session. Start it in the background
with the step's bindings and `--host 127.0.0.1`, give the URL, and stop it
before starting the next one: `serve` binds every interface unless told
otherwise, and a client's code is not to be published on their network.

## Predict, then reveal (only if asked)

Some people learn more by guessing first: before a ranking is shown, they name
what they expect to top it. Offer this once, at intake; it is off unless the
person says yes. When it is on, ask for the guess before the **Show** beat and
record the gap between guess and result as a finding said by a person. The
gap is often the most useful line of the notebook.

## When the session is long

A long conversation is compacted, and what is not on disk is forgotten. So:
re-read `discovery.json` before every beat that writes, never carry a number
from memory into the notebook (read it from the saved file), and if you are
unsure where the walk stands, read the state and say where it stands before
doing anything else.
