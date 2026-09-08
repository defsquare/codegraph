import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Paths as the model writes them: `/`-separated on every OS, root-relative,
 * compared by code unit. The file table is sorted by these strings, and a
 * Windows `\` or a case-folding comparison would change every surrogate.
 */

export function slashes(path: string): string {
  return path.replaceAll("\\", "/");
}

/** The typed path with `/` separators and no trailing slash — the header's `root`. */
export function display(typed: string): string {
  let text = slashes(typed);
  while (text.length > 1 && text.endsWith("/")) text = text.slice(0, -1);
  return text.length === 0 ? "." : text;
}

/** Absolute, normalised, `/`-separated — the form every path is compared in. */
export function absolute(path: string, cwd: string): string {
  return slashes(resolve(cwd, path));
}

export function relativeTo(rootFull: string, fileFull: string): string {
  const rel = slashes(relative(rootFull, fileFull));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${fileFull} is not under ${rootFull}`);
  }
  return rel;
}

/** Relative even when outside: `../shared/x.ts` names a file the roots do not cover. */
export function relativeOrOutside(rootFull: string, fileFull: string): string {
  return slashes(relative(rootFull, fileFull));
}

/** Deepest common ancestor of absolute directories — one root, no absolute anchor. */
export function commonRoot(fullDirectories: readonly string[]): string {
  if (fullDirectories.length === 0) throw new Error("at least one source root is required");
  let common = fullDirectories[0] as string;
  for (const candidate of fullDirectories.slice(1)) {
    while (!isUnder(candidate, common)) {
      const parent = dirname(common);
      if (parent === common) return common;
      common = parent;
    }
  }
  return common;
}

export function isUnder(full: string, root: string): boolean {
  const rootWithSeparator = root.endsWith("/") || root.endsWith(sep) ? root : `${root}/`;
  return full === root || full.startsWith(rootWithSeparator);
}
