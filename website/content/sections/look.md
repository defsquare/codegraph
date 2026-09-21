---
title: "What does it look like?"
weight: 1
lead: "A visual representation of your code: packages are districts, classes are buildings, dependencies are arcs between roofs."
more:
  name: "Read the tutorial on reading a city"
  doc: "tutorials/reading-the-city/"
---

Packages are districts, nested to reflect their hierarchy. Classes are buildings whose height and footprint follow the metrics you choose: lines of code and member count by default, cyclomatic complexity. Dependencies are arcs from roof to roof.

A dependency the model inferred is drawn desaturated. Red is reserved for the edges that represent cyclic dependencies. Unmeasured buildings are drawn at the minimum.
