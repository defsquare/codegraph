/**
 * `@codegraph/viz` as a LIBRARY: the city view, mountable into any host
 * element. The navigator frontend embeds it as a tab; `main.ts` mounts it
 * full-window for the standalone page. Three.js stays confined here — a
 * consumer imports this package, never `three`.
 */
export { mountCityView } from "./cityView.js";
export type { CityView, CityViewOptions, NavigatorTarget } from "./cityView.js";
