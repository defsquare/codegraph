---
title: "What it does not do"
weight: 7
lead: "Stated first, so an afternoon is not lost finding out."
more:
  name: "Read what extraction without compiling costs"
  doc: "explanation/extracting-without-compiling/"
---

### Java only, today.

Nine language profiles exist on paper; the shipped extractor is Java. A second language is the next milestone, and the interchange contract is published so an extractor in any language can conform.

### No build means imperfect resolution.

Without a classpath some references stay unresolved and become stubs. A stub is honest, but it is still a gap. Keep one package to one source root per run.

### Explanations cost money and need a network.

It is the only command that does. The plan and the estimate come first, and a cap on calls is one flag away.

### Not a linter.

Codegraph reports structure, coupling and cycles. It does not judge style and it does not find bugs.
