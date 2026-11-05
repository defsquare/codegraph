import {
  composeViews,
  declaredOnly,
  identityView,
  internalOnly,
  type View,
  type ViewDescriptor,
} from "@codegraph/analyzer";
import type { ViewOptions } from "./args.js";

/**
 * `--internal-only` / `--declared-only` resolved to the analyzer's view.
 *
 * One place, so every command answers the same flags with the same projection —
 * and so the view DESCRIPTOR every report and export prints (`internalOnly+declaredOnly`)
 * is composed in one order rather than per command. The CLI does not define
 * predicates of its own: the views are the analyzer's (CLAUDE.md invariant 6,
 * decision 7).
 */
export function resolveView(options: ViewOptions): View {
  const views: View[] = [];
  if (options.internalOnly) views.push(internalOnly);
  if (options.declaredOnly) views.push(declaredOnly);
  if (views.length === 0) return identityView;
  if (views.length === 1) return views[0] as View;
  return composeViews(...views);
}

/** A view as a report's header states it: a number without its view is not a fact. */
export function viewLabel(view: ViewDescriptor): string {
  return view.filters.length === 0
    ? `${view.name} (nothing filtered — stubs and inferred edges included)`
    : `${view.name} (${view.filters.join(", ")})`;
}
