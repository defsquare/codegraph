// codegraph-typescript — the bin entry, and nothing else: tsup prepends
// `#!/usr/bin/env node`, so importing this file RUNS the extractor. Everything
// reusable lives in main.ts, which is what the tests import.
//
// `process.exitCode` rather than `process.exit()`: exiting outright can
// truncate stderr still queued on a pipe, and the summary is what a CI log
// wants to see last.
import { processIo, run } from "./main.js";

process.exitCode = run(process.argv.slice(2), processIo(), process.cwd());
