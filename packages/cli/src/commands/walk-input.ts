import { readFileSync } from "node:fs";
import { SelectorError } from "@codegraph/analyzer";
import { WalkDefinitionError } from "@codegraph/insights";
import { UsageError } from "../exit.js";

/**
 * What `walk` and `explain` read BEFORE a run: the files a user names (a
 * definition, a task, instructions) and the faults in them. Kept apart from the
 * runner so that `walk --print-definition`, and every refusal of a definition,
 * answer without loading a model provider's SDK.
 */

/** The one read a walk's inputs need of the filesystem: undefined when the path cannot be read. */
export interface InputFs {
  readFile(path: string): string | undefined;
}

export function realInputFs(): InputFs {
  return {
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/** A file the user named, as text: unreadable is a usage error naming the flag. */
export function textOf(fs: InputFs, path: string, flag: string): string {
  const text = fs.readFile(path);
  if (text === undefined) throw new UsageError(`${flag} cannot read ${path}`, "The path is read relative to the current directory.");
  return text;
}

/** A JSON file the user named: not JSON is a usage error naming the file. */
export function readJson(fs: InputFs, path: string, flag: string): unknown {
  const text = textOf(fs, path, flag);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(
      `${flag} ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      "A walk definition is one JSON object; codegraph walk --print-definition prints one to start from.",
      { cause: error },
    );
  }
}

/** `--instructions TEXT|@FILE`, read. */
export function instructionsOf(raw: string | undefined, fs: InputFs): string | undefined {
  if (raw === undefined) return undefined;
  return raw.startsWith("@") ? textOf(fs, raw.slice(1), "--instructions") : raw;
}

/**
 * A fault in a selector or a definition is the user's to fix: a usage error listing every issue with its path —
 * and, when a flag was folded over that key (`flags`: key path → flag), the flag it came from.
 */
export function asUsageError(error: unknown, origin: string, flags: ReadonlyMap<string, string> = new Map()): unknown {
  if (error instanceof SelectorError) {
    return new UsageError(`${origin}: ${error.path === "" ? "" : `${error.path}: `}${error.message}`, "codegraph walk --help lists the selector terms.", { cause: error });
  }
  if (error instanceof WalkDefinitionError) {
    const lines = error.issues.map((issue) => {
      const flag = [...flags].find(([path]) => issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`))?.[1];
      return `  ${issue.path === "" ? "(the file)" : issue.path}${flag === undefined ? "" : ` (from ${flag})`}: ${issue.message}`;
    });
    return new UsageError(
      `${origin} is not a valid walk definition (${error.issues.length} fault${error.issues.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
      "codegraph walk --print-definition prints one to start from; codegraph walk --print-definition explain, explain's.",
      { cause: error },
    );
  }
  return error;
}
