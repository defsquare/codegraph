import type { BuildingBox } from "./buildings.js";
import type { Plate } from "./districts.js";

/**
 * The hover tooltip's single line. Labels CONCATENATE the identity components
 * the artifact carries (`module/symbol#disambiguator`) — the renderer never
 * parses an id (CLAUDE.md invariant 7). Artifacts from before `identity`
 * existed fall back to the name; the id, shown opaquely, is the last resort.
 */
export function buildingLabel(box: BuildingBox): string {
  const identity = box.identity;
  if (identity !== undefined) {
    const disambiguator = identity.disambiguator === undefined ? "" : `#${identity.disambiguator}`;
    return `${identity.module}/${identity.symbol}${disambiguator}`;
  }
  return box.name ?? box.id;
}

export function districtLabel(plate: Plate): string {
  return plate.identity?.module ?? plate.name ?? plate.id;
}
