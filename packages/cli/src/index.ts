// @codegraph/cli — the `codegraph` command. The bin entry, and nothing else:
// tsup prepends `#!/usr/bin/env node`, so importing this file RUNS the CLI.
// Everything reusable lives in main.ts / args.ts / io.ts, which is what tests
// import.
//
// `process.exitCode` rather than `process.exit()`: exiting outright can truncate
// a large artifact still queued on a redirected stdout, and `codegraph export
// … > graph.dot` on a 15 000-entity corpus is exactly that case.
import { processIo } from "./io.js";
import { run } from "./main.js";

process.exitCode = run(process.argv.slice(2), processIo());
