---
type: llm
weight: 1
---

The reply locates the bug in `Cart.total()` (Cart.java): the tax is added once in `withTax` and a second time in the return statement. The fix it gives returns `withTax`, or adds `tax.on(net)` only once.
