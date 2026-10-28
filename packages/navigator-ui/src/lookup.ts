/**
 * A LOOKUP OF THE SERVER THE PAGE CAME FROM — `insight.json`, `carriers.json`,
 * `glossary.json`: answers `codegraph serve` computes per request, which no
 * static host, Vite dev server or app daemon has.
 *
 * Asked once per URL, shared by concurrent askers and remembered. A server
 * that answers with something that is not JSON (index.html from a host that
 * answers every path, the daemon's bare 404) has no such route: it is asked
 * once, not once per click. Every failure is the caller's `none`.
 */
export type Fetcher = (url: string) => Promise<Response>;

export const noStore: Fetcher = (url) => fetch(url, { cache: "no-store" });

/** URLs are RELATIVE: under the app daemon the page lives at /<token>/, and so must they. */
export function rememberedLookup<A>(parse: (json: unknown) => A, none: A, fetcher: Fetcher = noStore): (url: string) => Promise<A> {
  const asked = new Map<string, Promise<A>>();
  let noRoute = false;

  const ask = async (url: string): Promise<A> => {
    try {
      const response = await fetcher(url);
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        noRoute = true;
        return none;
      }
      return parse(json);
    } catch {
      return none;
    }
  };

  return (url) => {
    if (noRoute) return Promise.resolve(none);
    let pending = asked.get(url);
    if (pending === undefined) {
      pending = ask(url);
      asked.set(url, pending);
    }
    return pending;
  };
}
