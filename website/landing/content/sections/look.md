---
title: "What does it look like?"
weight: 1
lead: "A city you can walk. **Every visual channel is a documented metric**, and colour is never decoration."
cmd: "codegraph city gson.jsonl --serve"
more:
  name: "Read the tutorial on reading a city"
  doc: "tutorials/reading-the-city/"
---

Packages are districts, nested like the packages they are. Classes are buildings whose height and footprint follow the metrics you choose: lines of code and member count by default, cyclomatic complexity when the extractor measured it. Dependencies are arcs from roof to roof.

A dependency the model inferred is drawn desaturated, so it can never pass for a fact. Red is reserved for the edges whose cut would break a cycle. Unmeasured buildings are drawn at the minimum and labelled unmeasured rather than faked.
