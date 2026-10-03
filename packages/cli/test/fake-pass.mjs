// The FAKE PASS: honours the pass command line (registry.ts, PLAN §18.3) —
// `<model.jsonl> --src DIR`, rewriting the model in place, progress on stderr,
// exit 0/1/2 — and nothing else. It replaces the model with the enriched Java
// fixture, as `codegraph-metrics` would have rewritten the fixture's model.
//
//   FAKE_PASS_LOG   when set, append one line per run — proves a run happened (or did not)
//   FAKE_PASS_FAIL  when set, exit 1 after a stderr line, the model untouched
import { appendFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [model, flag, src, ...rest] = process.argv.slice(2);
if (model === undefined || flag !== "--src" || src === undefined || rest.length > 0) {
  process.stderr.write("fake-pass: usage: fake-pass <model.jsonl> --src DIR\n");
  process.exit(2);
}
if (process.env.FAKE_PASS_LOG) appendFileSync(process.env.FAKE_PASS_LOG, `${model} --src ${src}\n`);
if (process.env.FAKE_PASS_FAIL) {
  process.stderr.write("fake-pass: cannot read the sources\n");
  process.exit(1);
}
process.stderr.write("fake-pass: 70 of 87 measured entities joined\n");
copyFileSync(fileURLToPath(new URL("../../../fixtures/java/expected/model.metrics.jsonl", import.meta.url)), model);
