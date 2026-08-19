package dev.codegraph.spoon;

import dev.codegraph.spoon.model.Entity;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

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
 * <p><b>Only type-shaped ids can be stubbed</b>, and that is a constraint of the
 * metamodel rather than a convenience: {@code isStub} is TType's key, and the
 * Java profile licenses TType for type kinds only — a {@code package} stub would
 * fail the profile's upper bound, and a {@code method} stub would need a
 * degraded-member concept core does not have. So a dangling member id (it should
 * not arrive: the edge pass retargets external members to their declaring type's
 * stub) or a dangling package id (an {@code import} of a package outside the
 * corpus) is REPORTED on stderr and left dangling, to be caught by the
 * analyzer's closure property. Naming a {@code class} after {@code java.util}
 * or after {@code bill(Order)} would be a fabrication, which is the one thing
 * this pass exists to prevent.
 *
 * <p>The stub's TNamed {@code name} comes from {@link EntityIds#typeSimpleName}:
 * the extractor owns its id scheme and may read it back. The analyzer may not.
 */
public final class StubSynthesizer {

  private static final String STUB_KIND = "class";

  private List<String> anomalies = List.of();

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
    if (whitelist == null) {
      throw new IllegalArgumentException("stub synthesis needs the corpus whitelist");
    }
    if (referencedIds == null || referencedIds.isEmpty()) {
      anomalies = List.of();
      return List.of();
    }

    List<String> reported = new ArrayList<>();
    List<Entity> stubs = new ArrayList<>();
    // TreeSet: deduplicated by id and sorted, whatever the caller handed over.
    for (String id : new TreeSet<>(referencedIds)) {
      if (id == null || id.isBlank()) {
        continue;
      }
      if (whitelist.declares(id)) {
        reported.add(
            "declared by the corpus but never emitted by the entity pass — extraction bug, not a stub: "
                + id);
        continue;
      }
      if (!isTypeShaped(id)) {
        reported.add("not a type id, so it cannot be a stub (METAMODEL.md §6): " + id);
        continue;
      }
      stubs.add(
          Entity.builder(id, STUB_KIND).named(EntityIds.typeSimpleName(id)).type(true).build());
    }

    anomalies = List.copyOf(reported);
    for (String anomaly : anomalies) {
      System.err.println("warning: " + anomaly);
    }
    return List.copyOf(stubs);
  }

  /**
   * What the last {@link #synthesize} call refused to fabricate, in the order it
   * was reported. Empty is the healthy state.
   */
  public List<String> anomalies() {
    return anomalies;
  }

  /**
   * {@code java:<pkg>/<Type>} or {@code java:<pkg>/<Outer>.<Inner>}. A package id
   * has no {@code /}; every member id carries a {@code (} or a {@code #}. A field
   * id is genuinely indistinguishable from a nested type id — both are
   * {@code Owner.name} — which is another reason the edge pass must retarget
   * external members to their declaring type rather than lean on this check.
   */
  private static boolean isTypeShaped(String id) {
    if (!id.startsWith(EntityIds.PREFIX)) {
      return false;
    }
    String body = id.substring(EntityIds.PREFIX.length());
    int slash = body.indexOf('/');
    if (slash < 0 || slash == body.length() - 1) {
      return false;
    }
    String typePath = body.substring(slash + 1);
    return typePath.indexOf('(') < 0 && typePath.indexOf(')') < 0 && typePath.indexOf('#') < 0;
  }
}
