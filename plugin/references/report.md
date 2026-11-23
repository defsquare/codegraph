# The report

`$WS/REPORT.md` is what the person takes out of the room. It is **rewritten
whole at every stop** — a gate answered "stop", the end of a tour, a session
that is about to end — from the state file, never from the conversation.

`NOTEBOOK.md` is the log: one entry per step, appended as the walk goes.
`REPORT.md` is the summary of where the walk stands now.

## Where it comes from

Read `discovery.json` again, then write. Every number is copied from the
state or from the saved file a finding's anchor names; none is remembered,
none is rounded differently than where it was read. If the state does not
hold something, the report does not say it.

## Its sections, in this order

```markdown
# <repository> — discovery report

<day>, at commit <first 7 characters>. codegraph <version>.
Steps done: … · not done: …

## In brief
## What was found
## The hotspot shortlist
## Questions for the team
## What was not looked at
## What was spent
```

- **In brief.** Ten lines at most: what this codebase is, in the words of the
  findings — size and shape, the style and whether it holds, where the effort
  goes, the one or two things to look at first. After a tour, this section is
  the brief you give in the conversation.
- **What was found.** Per step done, each finding on one line: its kind in
  bold, what was found, the file to check it in.
  `- **derived** — the size curve breaks after OwnerController. queries/04-largest-types.json`
- **The hotspot shortlist.** Only when step 3 ran: the five to ten files, each
  with revisions, lines, cyclomatic complexity, fix density, the families it
  ranks high in, and how it is held — "24 authors, the main one wrote 16% of
  it, last seen 2014-08".
- **Questions for the team.** Every entry of `questions` that is open, grouped
  by who could answer. This list is a deliverable of its own: what no file
  can say.
- **What was not looked at**, each with its reason:
  - the steps not run, and why (not reached, skipped by the person, needs a
    yes, not carried by this version of the plugin);
  - `corpus.excluded`, each path with who excluded it;
  - languages counted at preflight that have no extractor, or whose extractor
    is not installed, with their file counts;
  - what the extractor of this language does not give (`capabilities.md`):
    no annotation census, external code filed under a few roots, no framework
    profile, a module that is a file;
  - the history: the window that was mined, or that there was none to mine;
  - every source root that was `guessed`.
- **What was spent.** `spend`, one line per run, as the command reported it.
  When it is empty, the sentence is: "Nothing: no model provider was called."

## Its order follows the purpose

`intake.purpose` moves the sections of "What was found"; it removes none.

| Purpose | Leads with |
|---|---|
| `due-diligence` | the hotspot shortlist and how it is held, the cycles, the checks that failed |
| `migration` | the doors and the outbound systems of step 2, then steps 4 and 6 when they ran |
| `takeover`, `onboarding` | the terrain of step 1, then the shortlist as a reading order |
| none given | the steps in their order |

## What it never holds

- **A person's name or address.** Ownership is a share, a count and a date.
  Names are in `reports/authors.json`, which stays in the workspace. Before
  you finish, read the report once for any `Name <address>` you copied by
  accident, and remove it.
- **A guess that looks like a fact.** Every line built on a root with
  `guessed: true`, an exclusion `by: "agent"`, or a window you chose by the
  page's rule ends with "(guess)".
- **A claim without its kind and its file.** A sentence you cannot anchor
  belongs under "Questions for the team", as a question.
- **A price.** What was spent is what `spend` holds; what a step would cost
  is read from that step's own estimate when it runs, never written here.
- **Advice the method does not give.** The report says what was found and
  what was not. What to do about it is the person's.
