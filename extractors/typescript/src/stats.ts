/**
 * The stderr summary, in the Java and C# extractors' format. The rate
 * measures the corpus's DEPENDENCY SURFACE (PLAN.md §5.3): a package that is
 * not under the roots cannot be resolved by any extractor, so a low rate is a
 * fact about the corpus, and the stub discipline is the property worth
 * asserting. The `any`-receiver count is this profile's stated ceiling.
 */
export class ResolutionStats {
  typeReferences = 0;
  unresolved = 0;
  imports = 0;
  importsUnresolved = 0;
  importsWorkspaceResolved = 0;
  selfEdgesDropped = 0;
  anyReceiversDropped = 0;
  computedAccessesDropped = 0;
  computedImportsDropped = 0;
  heritageExpressionsDropped = 0;
  namelessClassesDropped = 0;
  /** Same-keyed declarations in one file: the later one re-keyed by its kind or position. */
  readonly duplicateKeys: string[] = [];
  /** Stubs by origin, for the summary line. */
  stubs = { lib: 0, packages: 0, unresolved: 0, modules: 0 };

  get resolved(): number {
    return this.typeReferences - this.unresolved;
  }

  noteTypeReference(resolved: boolean): void {
    this.typeReferences += 1;
    if (!resolved) this.unresolved += 1;
  }

  noteImport(outcome: "resolved" | "unresolved" | "workspace"): void {
    this.imports += 1;
    if (outcome === "unresolved") this.importsUnresolved += 1;
    if (outcome === "workspace") this.importsWorkspaceResolved += 1;
  }

  summary(entities: number, stubs: number, edges: number): string {
    const rate = this.typeReferences === 0 ? 100 : (100 * this.resolved) / this.typeReferences;
    return [
      "RESOLUTION SUMMARY",
      `  type references : ${this.typeReferences}`,
      `  resolved        : ${this.resolved}`,
      `  unresolved      : ${this.unresolved}`,
      `  resolution rate : ${rate.toFixed(1)}%`,
      `  any-typed receivers (dropped) : ${this.anyReceiversDropped}`,
      `  imports         : ${this.imports} (unresolved: ${this.importsUnresolved}, workspace-resolved: ${this.importsWorkspaceResolved})`,
      `  entities        : ${entities} (stubs: ${stubs} — lib ${this.stubs.lib}, packages ${this.stubs.packages}, <unresolved> ${this.stubs.unresolved}, modules ${this.stubs.modules})`,
      `  edges           : ${edges} (self-edges dropped: ${this.selfEdgesDropped}, computed accesses dropped: ${this.computedAccessesDropped}, computed imports dropped: ${this.computedImportsDropped}, heritage expressions dropped: ${this.heritageExpressionsDropped}, nameless classes dropped: ${this.namelessClassesDropped})`,
      `  duplicates      : ${this.duplicateKeys.length} same-keyed declarations re-keyed (first in file order keeps the plain key)`,
      "",
    ].join("\n");
  }
}
