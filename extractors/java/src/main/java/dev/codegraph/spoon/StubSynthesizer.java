package dev.codegraph.spoon;

import dev.codegraph.spoon.model.Entity;
import java.util.List;
import java.util.Set;

/**
 * PASS 4 — one degraded entity per id that was REFERENCED but never DECLARED.
 *
 * <p>A stub is not a separate node type (METAMODEL.md §6): it is an entity with
 * {@code TType} and {@code isStub: true}, deliberately degraded —
 * {@code {kind: "class", traits: ["TNamed", "TType"], isStub: true}} — with no
 * children, no parent and no anchor, because there is no corpus evidence to
 * anchor it to. Core exempts stubs from the profile's required-trait lower bound
 * for exactly this reason; the upper bound still applies, so a stub may not
 * carry traits the {@code class} kind does not license.
 *
 * <p>Edges to stubs are KEPT. The internal-only view is the analyzer filtering
 * {@code isStub}, not the extractor dropping facts.
 *
 * <p>Which ids arrive here is decided by the pipeline, not by this class:
 * {@code Main} passes the ids referenced by the entity and edge passes minus the
 * ids those passes emitted. Membership is re-checked against
 * {@link CorpusWhitelist} — an id in the whitelist but missing from the entity
 * pass is an extraction bug (a declared entity that was never emitted), NOT a
 * stub, and must be reported rather than papered over with a fake external type.
 *
 * <p>The stub's TNamed {@code name} comes from {@link EntityIds#typeSimpleName}:
 * the extractor owns its id scheme and may read it back. The analyzer may not.
 */
public final class StubSynthesizer {

  /**
   * PASS 4.
   *
   * @param referencedIds ids that appeared as an edge endpoint, a
   *     {@code declaredType} or a candidate, and that no declared entity covers
   * @param whitelist pass 1's answer to "is this declared here?" — the ONLY
   *     legitimate membership test; a package or name prefix is never one,
   *     because Spoon invents plausible FQNs in noClasspath mode
   * @return degraded {@code isStub} entities, one per external type
   */
  public List<Entity> synthesize(Set<String> referencedIds, CorpusWhitelist whitelist) {
    throw new UnsupportedOperationException("M2: the stub agent fills this in");
  }
}
