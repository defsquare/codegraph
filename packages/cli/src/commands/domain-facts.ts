import { Buffer } from "node:buffer";
import {
  FRAMEWORK_PROFILES,
  buildDomainFacts,
  domainFactsToJsonString,
  type DomainFacts,
} from "@codegraph/analyzer";
import type { DomainFactsOptions } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { errLine, errLines, type IoSink } from "../io.js";
import { openAnalysis, type AnalysisSource } from "../source.js";
import { resolveView } from "../view.js";

/**
 * `codegraph domain-facts <model.jsonl...> [--framework NAME]`.
 *
 * Writes the DOMAIN-FACTS artifact — one dossier per corpus type, every fact
 * pre-joined for a domain-extraction consumer — as JSON on stdout, or to
 * `--out FILE`. The transform lives in `@codegraph/analyzer`
 * (`buildDomainFacts`); this command only resolves flags, loads models and
 * moves bytes (decision 7).
 *
 * STREAM PURITY (decision 3): with no `--out`, stdout carries the artifact and
 * nothing else. Warnings, the cache note and the `--out` confirmation are
 * stderr.
 */
export function domainFactsCommand(options: DomainFactsOptions, io: IoSink): ExitCode {
  const source = openAnalysis(options.models, options, io);
  try {
    // The registry is validated data; an unknown name never reaches here — the
    // spec's `choices` rejected it as a usage error with the valid list.
    const profile =
      options.framework === undefined ? undefined : FRAMEWORK_PROFILES[options.framework];
    const facts = buildDomainFacts(source.graph(), {
      view: resolveView(options),
      ...(profile === undefined ? {} : { framework: profile }),
    });
    const artifact = domainFactsToJsonString(facts);

    errLines(io, warnings(source));

    if (options.out !== undefined) {
      io.writeFile(options.out, artifact);
      errLine(
        io,
        `wrote ${plural(Buffer.byteLength(artifact, "utf8"), "byte")} to ${options.out} ` +
          `(${describe(facts)}).`,
      );
    } else {
      io.out(artifact);
    }

    return source.clean ? EXIT.OK : EXIT.FINDINGS;
  } finally {
    source.close();
  }
}

function plural(count: number, noun: string, plural_ = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural_}`;
}

/** What the artifact is, for the human stream only. */
function describe(facts: DomainFacts): string {
  return (
    `domain facts, view ${facts.view.name}, ${plural(facts.types.length, "type dossier")}, ` +
    `${plural(facts.diagnostics.operations, "operation")}`
  );
}

function warnings(source: AnalysisSource): readonly string[] {
  if (source.clean) return [];
  return [
    `warning: the models are not clean; the dossiers were built anyway.`,
    `Run 'codegraph validate ${source.paths.join(" ")}' for the detail.`,
  ];
}
