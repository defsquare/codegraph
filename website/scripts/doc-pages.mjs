// What the tests read of the documentation's Markdown: which page a site path
// is, and its sections by the id Hugo gives each heading. Test support only.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { site } from "./diagram-kit.mjs";

/** Hugo's default heading id (GitHub's rule): lowercase, punctuation dropped, a hyphen per space. */
export const anchor = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");

/** The Markdown file a site path (`/docs/…/`, fragment ignored) renders from, or undefined. */
export function pageFile(href) {
  const page = join(site, "content", href.split("#")[0]);
  return [join(page, "_index.md"), `${page.replace(/\/$/, "")}.md`].find((candidate) => existsSync(candidate));
}

/** A page's sections: heading id → the text up to the next heading of any level. */
export function sections(file) {
  const out = new Map();
  let current = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^#{1,6} /.test(line)) out.set((current = anchor(line.replace(/^#+ /, ""))), "");
    else if (current) out.set(current, `${out.get(current)}${line}\n`);
  }
  return out;
}

/** Every distinct `<a href>` of a diagram is a page, and its fragment one of that page's headings. */
export function assertLinksResolve(svg, assert) {
  const hrefs = [...svg.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of new Set(hrefs)) {
    if (href === "/") continue;
    const file = pageFile(href);
    assert.ok(file, `${href}: no page`);
    const fragment = href.split("#")[1];
    if (fragment !== undefined) assert.ok(sections(file).has(fragment), `${href}: no such heading in ${file}`);
  }
  return hrefs;
}
