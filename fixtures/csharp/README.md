# `fixtures/csharp` — the reference corpus for the C# extractor

What this corpus pins, file by file, and how to reproduce its snapshot is in
[`docs/csharp-extractor.md`](../../docs/csharp-extractor.md).

## The vocabulary: `order` and `priceable`, counted by hand

`expected/vocabulary.json` is the words of this model's names
(`@codegraph/vocabulary`, PLAN.md §20), rebuilt byte for byte by
`pnpm --filter @codegraph/vocabulary test` (`CODEGRAPH_UPDATE_SNAPSHOTS=1`
rewrites it). A word weighs the role of the entity whose name carries it —
module and type 8, attribute 4, operation 3, parameter and local 1 — except a
word of the name's qualifier, before the last separator of a qualified kind,
which weighs 1. One word, counted by hand from the model and pinned by the
vocabulary's tests:

| name | kind | role | weight |
|---|---|---|---|
| `Acme.Order` | namespace | module | 8 |
| `AbstractOrder`, `Order`, `OrderService` | class | type | 3 × 8 |
| `order` × 6 | parameter | parameter | 6 × 1 |
| `order` | localVariable | local | 1 |
| `Acme.Order.Adapter`, `Acme.Order.Extensions`, `Acme.Order.Legacy` | namespace | qualifier | 3 × 1 |

**`order`: weight 42, 14 occurrences, 14 carriers.** The interface prefix is a
marker, not a word: `IPriceable` (type, 8) and the parameter `priceable` (1)
make **`priceable`: weight 9, 2 occurrences**, and no word `i`.
