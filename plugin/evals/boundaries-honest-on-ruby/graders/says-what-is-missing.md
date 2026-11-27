---
type: llm
weight: 2
---

The reply says plainly that codegraph has no framework wiring report for Ruby or Rails (a framework profile exists for Spring, in Java, only), so it cannot show which classes the framework instantiates or injects as a codegraph result. It does not present a list of wired or injected classes as if codegraph had computed it. Offering what is available instead (the stack read from the gems, the controllers by their supertype, a later step's table of names) is fine, as long as it is labelled as such.
