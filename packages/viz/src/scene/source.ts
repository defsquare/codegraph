import type { BuildingSource, CityLayout } from "@codegraph/city";

/**
 * "View source" — the ONE projection of the artifact's repository facts
 * (METAMODEL §8a/§9). The model stores `remote`, `commit` and the repo-relative
 * `root`; the blob URL of a particular host is presentation, and it lives here,
 * in the consumer, so no host's scheme is ever frozen into the interchange.
 *
 * Two rules keep a link from lying:
 *   - the COMMIT is a permalink, and a replay passes the SCRUBBED tick's sha,
 *     so the file that opens is the one the city is showing;
 *   - a host whose template we do not know produces NO link. A GitHub-shaped
 *     guess at a Gitea server is a 404 the user has to diagnose.
 */
export type RepositoryFacts = NonNullable<CityLayout["corpus"]["repository"]>;

type Provider = "github" | "gitlab";

export function sourceUrl(
  repository: RepositoryFacts | undefined,
  source: BuildingSource | undefined,
  commit: string = repository?.commit ?? "",
): string | undefined {
  if (repository === undefined || source === undefined || commit === "") return undefined;
  const provider = providerOf(repository);
  if (provider === undefined) return undefined;

  const path = [repository.root, source.file].filter((part) => part !== "").join("/");
  const blob = provider === "gitlab" ? "/-/blob/" : "/blob/";
  return `${repository.remote}${blob}${commit}/${path}${fragment(provider, source.span)}`;
}

/** The declared provider wins; otherwise the hostname is read, or nothing is. */
function providerOf(repository: RepositoryFacts): Provider | undefined {
  if (repository.provider !== undefined) return repository.provider;
  const host = repository.remote.slice("https://".length).split("/")[0]?.toLowerCase() ?? "";
  if (host.includes("gitlab")) return "gitlab";
  if (host.includes("github")) return "github";
  return undefined;
}

/** GitHub spells a range `#L1-L9`, GitLab `#L1-9`; one line is `#L1` on both. */
function fragment(provider: Provider, span: BuildingSource["span"]): string {
  if (span === undefined) return "";
  const [start, end] = span;
  if (end <= start) return `#L${start}`;
  return provider === "gitlab" ? `#L${start}-${end}` : `#L${start}-L${end}`;
}
