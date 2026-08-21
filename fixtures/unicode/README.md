# `fixtures/unicode` — the collation fixture

A synthetic model, not an extraction. There is no `src/`: no Java corpus is
needed to state what this fixture is about, and inventing one would suggest the
characters came from somewhere they did not.

## What it pins

Codegraph's canonical order (METAMODEL.md §1.1) compares strings **by UTF-16
code unit** — `compareIds` in `packages/analyzer/src/order.ts` is `a < b` on
JavaScript strings, and `compareNaturalKeys` in core does the same. SQLite's
default `BINARY` collation compares **UTF-8 bytes**, which is code-point order.

For everything in the Basic Multilingual Plane the two agree. For a
supplementary-plane character they do not, because JavaScript stores it as a
surrogate pair in `D800..DFFF` while UTF-8 encodes it above everything in the
BMP:

| identifier | first UTF-16 unit | first UTF-8 byte |
|---|---|---|
| `𠀀Supplementary` (U+20000, CJK Ext. B) | `D840` | `F0` |
| `ＡFullwidth` (U+FF21, fullwidth A) | `FF21` | `EF` |

So UTF-16 puts `𠀀Supplementary` first and UTF-8 puts `ＡFullwidth` first — the
orders are opposite. Both characters are legal Java identifier letters, so this
is a corpus someone could really write.

The entity order in `expected/model.jsonl` is the canonical one, and the
surrogates prove it: `Ascii` is 1, `𠀀Supplementary` is 2, `ＡFullwidth` is 3.
Read back under a BINARY collation, 2 and 3 would swap — and since the surrogate
IS the identity of a reference, every edge in the file would then point at the
wrong entity.

## Why it is committed

`expected/analyze-deps-type.txt` and `expected/export-type.csv` were generated
by the CLI and committed as the reference. They are the artefact any later
change is diffed against — in particular the SQLite analysis store (PLAN.md
§9.3), whose whole risk is that it returns rows in the database's order rather
than the model's.

**The rule this fixture exists to document: sorting belongs to the model, never
to the storage engine.** A query that needs canonical order must sort in
TypeScript with `compareIds`, or `ORDER BY` a column the importer wrote in
canonical order — never rely on SQLite's own collation to reproduce it.
