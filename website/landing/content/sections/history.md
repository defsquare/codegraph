---
title: "How did it get this way?"
weight: 3
lead: "History is a dependency the source cannot show you."
cmd: |-
  codegraph scm ~/src/gson
  codegraph snapshots ~/src/gson --jar codegraph-java.jar --tags
  codegraph replay --store gson.db --history gson-history.jsonl --serve
more:
  name: "Read the tutorial on replaying history"
  doc: "tutorials/history-replay/"
---

Hotspots, ownership and co-change come from git alone. Sample a repository at its tags into a temporal store and replay the city through the years: buildings rise at birth and sink at death, change heat and age ride the colours, and files that always change together are joined by a dashed arc the declared graph cannot explain.

The join runs the other way too: declared dependencies that history never exercised together are reported as dead weight.
