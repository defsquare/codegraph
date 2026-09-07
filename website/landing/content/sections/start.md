---
title: "Sixty seconds to a city"
weight: 6
lead: "Node 22, pnpm and a JDK 17 or newer. Codegraph runs from a clone today; there is no package yet."
more:
  name: "The first tutorial walks through every step"
  doc: "tutorials/first-city/"
---

```
git clone https://gitlab.com/jgrodziski/codegraph.git && cd codegraph
pnpm install && pnpm -r build
(cd extractors/java && ./mvnw -B package)

java -jar extractors/java/target/codegraph-java.jar \
     --src ~/src/gson/gson/src/main/java --out gson.jsonl
./bin/codegraph validate gson.jsonl
./bin/codegraph city gson.jsonl --serve --host 127.0.0.1
```

On gson this takes about a minute end to end, most of it the clone. The city opens on port 4177; the navigator, on 4178. Both bind every interface unless you say otherwise, which is why the last line does.
