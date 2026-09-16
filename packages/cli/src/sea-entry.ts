// The single-executable image's entry (PLAN §15.3): the same `run` as
// index.ts, without top-level `await` — a SEA's main script is CommonJS, and
// this file is the one tsup builds as CJS (dist-sea/codegraph.cjs) before
// `node --experimental-sea-config` folds it into the blob. Everything else
// about the process is identical: argv, both streams, `process.exitCode`.
import { processIo } from "./io.js";
import { run } from "./main.js";

Promise.resolve(run(process.argv.slice(2), processIo())).then((code) => {
  process.exitCode = code;
});
