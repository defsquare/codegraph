# codegraph-typescript

The [Codegraph](https://github.com/defsquare/codegraph) extractor for
TypeScript: one compiler-API program over every `*.ts` under the roots you
name, no build and no `node_modules` needed, emitting a `model.jsonl` that
`codegraph` analyzes, navigates and renders as a code city.

```bash
npx codegraph-typescript --src <dir> [--src <dir>…] --out model.jsonl
```

Needs Node 22 or later and nothing else. The extractor reads a `tsconfig`
only for its resolution options; unresolved imports are reported, never
invented. Full reference: [docs/typescript-extractor.md](https://github.com/defsquare/codegraph/blob/main/docs/typescript-extractor.md).

The extractor's runtime dependency is `typescript` alone. MIT.
