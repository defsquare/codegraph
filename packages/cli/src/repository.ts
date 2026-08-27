import type { Repository } from "@codegraph/core";

/**
 * Repository provenance, derived from a git checkout (M10a, PLAN §12.1).
 *
 * The extractor has no git knowledge — it copies three strings from its flags —
 * so DERIVING them is the CLI's job, and the derivation is one function so that
 * `snapshots` and any later caller cannot disagree about what "the remote" is.
 *
 * A remote is a fact only once it is the normalized https form the interchange
 * demands (METAMODEL §8a): an ssh remote, a `.git` suffix or embedded
 * credentials all produce URLs that 404 or leak. What cannot be normalized
 * yields NOTHING — a model with no repository block renders no link, which is
 * honest, where a guessed URL would be a link that lies.
 */

/** Hosts whose web UI this projection is known to fit; anything else is refused. */
const SCP_LIKE = /^(?:([^@/]+)@)?([^@:/]+):(.+)$/;
const WITH_SCHEME = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i;

/**
 * `git remote get-url origin` → the normalized https clone URL, or undefined
 * when the remote is not a hosted one (a local path, a `file://` URL, plain
 * http we will not silently upgrade).
 */
export function normalizeRemote(url: string): string | undefined {
  const raw = url.trim();
  if (raw === "") return undefined;

  // A URL with a scheme is never read as the scp-like form: `file:///srv/repo`
  // would otherwise parse as host `file`, path `/srv/repo`.
  if (raw.includes("://")) {
    const scheme = WITH_SCHEME.exec(raw);
    if (scheme === null) return undefined;
    const [, protocol, host, path] = scheme as unknown as [string, string, string, string];
    // `http` is not upgraded: the scheme is a fact about the host, not a guess
    // ours to make. `file`/`ssh`/`git`/`https` are the forms git actually emits.
    if (!["https", "ssh", "git"].includes(protocol.toLowerCase())) return undefined;
    return build(host, path);
  }

  // scp-like: git@github.com:owner/repo.git — no scheme, host before the colon.
  const scp = SCP_LIKE.exec(raw);
  if (scp !== null) {
    const [, , host, path] = scp as unknown as [string, string | undefined, string, string];
    return build(host, path);
  }

  // A bare path (/srv/git/repo.git, ../sibling): a real remote, but not one a
  // browser can open. Nothing to say.
  return undefined;
}

function build(host: string, path: string): string | undefined {
  const cleaned = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  if (host === "" || cleaned === "") return undefined;
  if (/\s/.test(host) || /\s/.test(cleaned)) return undefined;
  return `https://${host}/${cleaned}`;
}

/**
 * The three facts together, or undefined when the remote is not projectable.
 * `root` is the analyzed root RELATIVE to the repository root — the M9b gson
 * gotcha (`--src gson/src/main/java`) as a data requirement: anchors are
 * relative to the analyzed root, which sits below it.
 */
export function repositoryFacts(
  remoteUrl: string | undefined,
  commit: string,
  root: string | undefined,
): Repository | undefined {
  if (remoteUrl === undefined) return undefined;
  const remote = normalizeRemote(remoteUrl);
  if (remote === undefined) return undefined;
  return { remote, commit, root: normalizeRoot(root) };
}

/** `./src/`, `src/`, `` all name the same prefix; the contract spells it one way. */
function normalizeRoot(root: string | undefined): string {
  if (root === undefined) return "";
  return root
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}
