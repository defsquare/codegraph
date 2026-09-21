---
title: "Codegraph"
# Selects layouts/landing/*.html, so Hextra's shell never wraps this page.
type: "landing"
metaTitle: "Codegraph - see the structure of any code"
headline:
  before: "See the"
  gradient: "structure"
  after: "of your code."
lead: >-
  Codegraph reads sources alone and turns them into a model
  you can query, walk as a 3D city, browse dependency by dependency, replay through its history,
  and have explained bottom-up.
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
    **The model codegraph extracted** from [google/gson](https://github.com/google/gson),
    drawn as it is laid out. Nine packages as plates, nested like the packages they are;
    113 classes as blocks whose height is lines of code and whose footprint is member count;
    in <span class="red">red</span>, the cyclic ependencies.
corpora:
  lead: "Run end to end on"
  items:
    - name: "google/gson"
      city: "city/?help=0&src=gson-city.json"
    - name: "apache/commons-lang"
      city: "city/?help=0&src=apache-common-lang-city.json"
    - name: "spring-petclinic"
      city: "city/?help=0&src=spring-petclinic-city.json"
    - name: "apache/fineract"
      city: "city/?help=0&src=fineract-loan-city.json"
---
