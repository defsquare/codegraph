---
title: "Sixty seconds to a city"
weight: 6
lead: "One Homebrew tap. The app and the command are one install; each language's extractor is its own. Nothing else to install: no JDK."
more:
  name: "The first tutorial walks through every step"
  doc: "tutorials/first-city/"
---

```
brew install --cask defsquare/tap/codegraph
brew install defsquare/tap/codegraph-java

codegraph-java --src ~/src/gson/gson/src/main/java --out gson.jsonl
codegraph validate gson.jsonl
codegraph serve gson.jsonl --host 127.0.0.1
```

On gson this takes about a minute end to end, most of it the download. One page opens on port 4177: the navigator, with the city as a tab. It binds every interface unless you say otherwise, which is why the last line does. Linux and Windows get the same binaries without the cask; the [install guide](/docs/how-to/install/) has the lines.
