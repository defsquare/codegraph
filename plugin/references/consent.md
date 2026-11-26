# Consent: show the cost, then ask

Step 5 is the one step that sends source code to a second model provider and
spends money. Before any model call, show the block below, filled from THIS
run's estimate, then ask one question. The block and the question are the
Specy skill's text, word for word (`domain-extract-from-code`,
`heuristics/codegraph.md` §1.4), and so are the four rules after them but for
where a no leads: change one, change the other.

## The block

```
## codegraph explain: what a run would cost
Scope: {SRC}: {units} units ({operation} operations, {type} types, {module} modules)
Model calls: {calls} ({template} described without a call, {reuse} already explained and reused)
Tokens: ~{promptTokens} in, ~{completionTokens} out
Served by: {provider}, {leaf model}{, {rollup model} for types and modules}. The source of each unit is sent there.
Estimated cost: ~${cost} at ${priceIn}/M in and ${priceOut}/M out ({where the prices were read}, {date})
              | your Claude plan: {calls} headless calls{, ~${cost} at list price}
              | unknown: no price found for {model}
Not counted: repair re-asks, rate-limit retries.
Duration: not estimated by the tool. One measured run made 1 800 calls in 50 minutes (OpenRouter, 4 in flight).
Cheaper: {a narrower scope}: {calls} calls, ~${cost}
```

Then ask one question: run it on everything, run it on the narrower scope, or
continue without it.

- **Wait for the answer.** Only an explicit yes starts a run, and it covers the
  scope and the estimate that were shown: a wider scope, another provider or
  model, or a later run that plans new calls is a new question.
- **Nobody to ask** (an unattended run, an instruction to ask no question):
  the answer is no. Keep the block in the notebook as what the run would have
  cost.
- **On a no**: no model call. Continue with what is free, and read the code
  for everything a fact does not settle.
- `--yes` is what lets the command spend without a terminal, so it stands for
  the person's consent: pass it only after that yes, never before.

## Filling it, in the walk

- **Every number comes from this run's `--estimate`**: `units`, `calls`,
  `byLevel`, `byStatus`, `promptTokens`, `completionTokens`, and `cost` when
  it was given two prices. None is remembered, none is computed by you.
- **A price is read or given, never remembered.** Ask the person for the two
  prices (dollars per million tokens, in and out), or read them from the
  provider's public price list, and say where and on which day. The cost line
  is the command's, run again with `--price-in` and `--price-out`. Claude Code
  is billed by the Claude plan: show the calls, and a list price only when one
  was read or given. No price found: say it is unknown.
- **The ceiling** is the one the person gave at intake
  (`intake.provider.ceilingUsd`). A cost above it is not proposed: the
  "Cheaper" line names a scope under it, or says none was found. A cost that
  is unknown is shown beside the ceiling, and the person decides.
- **The provider** is the one allowed at intake. A store already paid for
  with another provider's models would be explained again with this one:
  the block says so, under "Served by".
- **The answer is written** as a `said` finding under `steps.meaning.findings.run`
  when a person gave it in this step: the scope, the provider, the bound in
  calls, and the words of the answer. A no because nobody could be asked, or
  the no of intake, is said in the `run` finding's `note`, not as a `said`.
- **A no at intake** is not asked again: show the block once, as what a run
  would have cost, and continue without it.
