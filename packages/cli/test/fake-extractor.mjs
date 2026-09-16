// The FAKE EXTRACTOR: honours the §13.5 command line (schemas/README.md §8) and
// nothing else — `--src DIR` (repeatable), `--out FILE`, progress on stderr,
// stdout silent, exit 0/1/2. It copies a committed fixture snapshot to `--out`,
// so the daemon's tests exercise process lifecycle, progress plumbing and the
// build over a REAL model without a JDK, a .NET SDK or a compiler run.
//
//   FAKE_EXTRACTOR_MODEL  the model to copy (default: the Java fixture)
//   FAKE_EXTRACTOR_FAIL   when set, exit 1 after two stderr lines — the failure path
//   FAKE_EXTRACTOR_LOG    when set, append one line per run — proves a run happened (or did not)
//   FAKE_EXTRACTOR_SLOW_MS when set, wait this long before finishing — the 409 window
import { appendFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const sources = [];
let out;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--src") sources.push(args[++i]);
  else if (args[i] === "--out") out = args[++i];
  else if (args[i] === "--progress") i += 1;
  else if (args[i] === "--no-progress") continue;
  else if (args[i] === "--version") {
    process.stdout.write("fake-extractor 0.0.0\n");
    process.exit(0);
  } else {
    process.stderr.write(`fake-extractor: unknown option ${args[i]}\n`);
    process.exit(2);
  }
}
if (out === undefined) {
  process.stderr.write("fake-extractor: --out is required\n");
  process.exit(2);
}

if (process.env.FAKE_EXTRACTOR_LOG) {
  appendFileSync(process.env.FAKE_EXTRACTOR_LOG, `${sources.join(",")} -> ${out}\n`);
}

process.stderr.write(`fake: scanning ${sources.join(", ") || "."}\n`);
if (process.env.FAKE_EXTRACTOR_SLOW_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_EXTRACTOR_SLOW_MS)));
}
if (process.env.FAKE_EXTRACTOR_FAIL) {
  process.stderr.write("fake: cannot parse src/Broken.java\n");
  process.exit(1);
}
process.stderr.write("fake: 3 files, 179 entities\n");

const model =
  process.env.FAKE_EXTRACTOR_MODEL ??
  fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));
copyFileSync(model, out);
