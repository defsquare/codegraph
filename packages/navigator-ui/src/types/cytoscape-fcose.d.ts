/** cytoscape-fcose ships no types; it is registered once as a cytoscape extension. */
declare module "cytoscape-fcose" {
  import type { Ext } from "cytoscape";
  const fcose: Ext;
  export default fcose;
}
