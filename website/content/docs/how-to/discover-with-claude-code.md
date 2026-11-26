---
title: Walk a codebase with Claude Code
linkTitle: Discover with Claude Code
weight: 16
---

The [discovery walk](/docs/discover/) is six questions asked of a codebase in
a fixed order. The `codegraph` plugin for Claude Code turns it into a guide:
you give it a repository, it runs the commands of each step, shows you a few
rows at a time, keeps what the code states apart from what it infers, and
writes what was found to a workspace on disk, so a walk stops and resumes.
This guide installs the plugin, starts a walk, and says what it touches and
what it costs.

**Before you start:** Claude Code, the `codegraph` command and the extractor
of your repository's language ([Install codegraph](/docs/how-to/install/)).
The plugin installs nothing itself: when a tool is missing it prints the
`brew install` line and stops.

## Install the plugin

Two commands, in a Claude Code session:

```text
/plugin marketplace add defsquare/codegraph
/plugin install codegraph@codegraph
```

or from a shell:

```bash
claude plugin marketplace add defsquare/codegraph
claude plugin install codegraph@codegraph
```

The plugin is versioned with the `codegraph` command it drives, because its
skills spell the command's flags: keep the two at the same version.
`claude plugin update codegraph@codegraph` follows a new release, after
`brew upgrade`.

## Start a walk

In the repository, or with its path:

```text
/codegraph:discover path/to/repository
```

The guide checks the tools, asks at most three questions (what the walk is
for, how far to go now, whether source may be sent to a model provider and
paid for), creates the workspace and runs step 1. Each step ends on what it found and a
question: go on, go deeper, or stop. Ask again later and it resumes where
the workspace says it stopped.

Two other ways in:

- `/codegraph:discover path/to/repository --tour` runs steps 1 to 3 with no
  question and leaves `REPORT.md`: a first look, for free.
- `/codegraph:discover path/to/repository --step 4` goes straight to one
  step. Each step also has its own skill, `/codegraph:discover-4-stimuli` and
  so on, named on each step's page.

One question outside the walk:

```text
/codegraph:query path/to/repository which classes have the most callers?
```

writes the question as one read-only SQL statement over the model, runs it
with [`codegraph query`](/docs/reference/cli/query/), saves both and shows the
rows.

## What it writes, and where

One hidden directory at the root of the repository, `.codegraph/`, added to
the repository's own `.git/info/exclude`, never to `.gitignore`: no tracked
file changes and `git status` reads as before. It holds the models, every
query that was run with its rows, the walk's log (`NOTEBOOK.md`), the report
(`REPORT.md`, shares and counts, never a person's name) and the state of the
walk (`discovery.json`). Delete it and nothing is left. Step 6 adds Specy's
own `specy/` directory when the Specy plugin is there.

The plugin runs none of the analyzed project's code: no build, no test, no
script of its own.

## What it costs

Steps 1 to 4 and step 6 run codegraph on your machine: free, seconds. Step 5
is the one that calls a language model, and it asks first: it plans and
prices [`explain`](/docs/how-to/explain-cost/) for free, proposes a scope,
and sends source to a provider only after your yes for that scope, provider
and ceiling. On a no it reads the few types that matter itself and says so.
The session itself counts against your Claude plan, as any session does.

## From a checkout

To try the plugin from a clone of codegraph without installing it:

```bash
claude --plugin-dir plugin
```

`claude plugin eval plugin` runs its eval suite: whether the guide is chosen
for "help me understand this codebase" and not for a bug fix, whether step 5
waits for a yes, whether step 2 says what a language cannot give.

## Related

- [Discovering a codebase](/docs/discover/), the method the plugin runs
- [`codegraph query`](/docs/reference/cli/query/)
- [Install codegraph](/docs/how-to/install/)
- [Estimate, cap and scope an explain run](/docs/how-to/explain-cost/)
