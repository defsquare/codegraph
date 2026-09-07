---
title: "Codegraph"
metaTitle: "Codegraph — see the structure of code you did not write"
headline:
  before: "See the"
  gradient: "structure"
  after: "of code you did not write."
lead: >-
  Codegraph reads sources alone, with no build and no classpath, and turns them into a model
  you can query, walk as a 3D city, browse dependency by dependency, replay through its history,
  and have explained bottom-up. It works on the legacy nobody can compile any more.
cta:
  name: "Read the ten-minute tutorial"
  doc: "tutorials/first-city/"
ctaSecondary:
  name: "Browse the documentation"
  doc: ""
city:
  img: "img/gson-city.svg"
  width: 1200
  height: 860
  alt: >-
    The code city of google/gson: nine package plates, 113 class blocks sized by lines of code,
    and thirty red arcs marking the dependencies whose removal would break every cycle.
  caption: >-
    Not an illustration: the model codegraph extracted from **google/gson** at release 2.14.0,
    drawn as it is laid out. Nine packages as plates, nested like the packages they are;
    113 classes as blocks whose height is lines of code and whose footprint is member count;
    in <span class="red">red</span>, the thirty dependencies whose removal would leave the graph
    without a cycle. External types are hidden in this view.
corpora:
  lead: "Run end to end on"
  items:
    - name: "google/gson"
      note: "3,600 entities"
    - name: "apache/commons-lang"
      note: "15,000 entities"
    - name: "spring-petclinic"
      note: "framework wiring"
    - name: "apache/fineract"
      note: "127 MB model"
---
