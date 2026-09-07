---
title: "Why the picture can be trusted"
weight: 5
lead: "We built codegraph for codebases where the truth is in dispute. **It never claims more than the model contains.**"
more:
  name: "Read why facts and inferences never mix"
  doc: "explanation/facts-vs-inferences/"
---

### Facts and inferences never share an edge.

Every edge carries a provenance: `declared`, `derived`, `dynamic-candidate` or `generated`. A dependency read from the source is a different thing from one inferred from a framework annotation, and every report, picture and export keeps the two apart. `--declared-only` gives you the facts alone.

### Every claim points at a line.

Entities and edges carry a source anchor. When the navigator says one class depends on another through a given method, it shows the file and the span where that happens.

### No build is required.

The Java extractor runs Spoon without a classpath. What it cannot resolve becomes an explicit stub whose edges are kept, and stubs are decided by what the corpus declares, never by guessing from a package name.

### The outputs are boring on purpose.

Standard output is the artifact and standard error is for humans. Identical input gives byte-identical output, so a model diffs in a repository. Exit codes tell a bug in codegraph apart from a finding about your code, so a pipeline can gate on either.
