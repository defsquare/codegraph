---
title: "What does it mean?"
weight: 4
lead: "One explanation per method, class and package, written leaves first."
cmd: |-
  codegraph explain gson.jsonl --src gson/src/main/java --estimate
  codegraph explain gson.jsonl --src gson/src/main/java --max-calls 50
more:
  name: "Read the tutorial on explanations"
  doc: "tutorials/explain/"
---

A language model explains the leaf operations first, then their callers, then the types and the packages that own them. Each prompt carries the explanations already written for what the unit depends on, so every summary rests on parts already explained, and mutually dependent units are explained as one.

We estimate tokens and cost before a single call is made, and a re-run redoes only what changed. On the reference corpus a full run was 68 calls and about six cents. Explanations live in a side-car file; the model itself is never touched.
