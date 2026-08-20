package dev.codegraph.spoon;

import dev.codegraph.spoon.model.Entity;
import dev.codegraph.spoon.model.TraitName;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * PASS 4 — one degraded entity per id that was REFERENCED but never DECLARED.
 *
 * <p>A stub is not a separate node type (METAMODEL.md §6): it is an entity with
 * {@code TType} and {@code isStub: true}, deliberately degraded —
 * {@code {kind: "class", traits: ["TNamed", "TType"], isStub: true}} — with no
 * anchor, because there is no corpus evidence to anchor it to. Core exempts stubs
 * from the profile's required-trait lower bound for exactly this reason; the
 * upper bound still applies, so a stub may not carry traits the {@code class}
 * kind does not license.
 *
 * <p>ONE THING A STUB DOES CARRY: a {@code parent}, when its package is itself
 * external. The analyzer folds entities to module level by walking {@code parent}
 * and is forbidden to parse ids (CLAUDE.md 7), so a parentless external type
 * could only be placed in a module by guessing — and the analyzer's earlier
 * workaround, treating such a stub as its own module, put {@code java.io/PrintStream}
 * and even {@code int} into module dependency graphs as if they were modules.
 * The extractor owns the id scheme and knows the package for free, so the
 * knowledge belongs here. See {@link #attachableParent} for the two cases where
 * no honest parent exists.
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
 * <p><b>Only TYPE-shaped and PACKAGE-shaped ids can be stubbed</b>, and that is a
 * constraint of the metamodel rather than a convenience: {@code isStub} is
 * contributed by TType and TModule, and nothing else. A type id becomes a
 * degraded {@code class}; a package id becomes a degraded {@code package} with
 * {@code definedIn: []} — no corpus file declares it, which is precisely what
 * makes it external. The package case is not optional: the import graph is
 * module-level (METAMODEL.md §9), so {@code import java.util.List} yields an edge
 * to {@code java:java.util}, and without a module stub the first-class import
 * layer could never satisfy graph closure.
 *
 * <p>A dangling MEMBER id is still refused — it should not arrive at all, since
 * the edge pass retargets external members to their declaring type's stub, and a
 * {@code method} stub would need a degraded-member concept core does not have.
 * It is REPORTED on stderr and left dangling, to be caught by the analyzer's
 * closure property. Naming a {@code class} after {@code bill(Order)} would be a
 * fabrication, which is the one thing this pass exists to prevent.
 *
 * <p>The stub's TNamed {@code name} comes from {@link EntityIds#typeSimpleName}:
 * the extractor owns its id scheme and may read it back. The analyzer may not.
 */
public final class StubSynthesizer {

  private static final String STUB_KIND = "class";
  private static final String PACKAGE_STUB_KIND = "package";

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
    List<String> typeIds = new ArrayList<>();
    // TreeSet everywhere: the emitted set must not depend on the caller's iteration order.
    Set<String> packageIds = new TreeSet<>();

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
      if (isTypeShaped(id)) {
        typeIds.add(id);
      } else if (isPackageShaped(id)) {
        packageIds.add(id);
      } else {
        reported.add("not a type or package id, so it cannot be a stub (METAMODEL.md §6): " + id);
      }
    }

    // Two separate questions per stub type, and conflating them is a bug:
    //
    //   IDENTITY  — which module the id lives in. Part of the natural key (MM-1),
    //               so that module MUST exist as an entity or the type cannot be
    //               written at all: an interchange record names its module by
    //               reference, and there is no "unknown module" to point at.
    //   CONTAINMENT — whether the type gets a `parent`. Refusable, and refused in
    //               the two cases below, because claiming containment we cannot
    //               honestly claim is what mislabels a module-level analysis.
    //
    // So every stub type's package is materialized, while `parent` stays subject
    // to attachableParent's refusals.
    Map<String, String> parentOf = new TreeMap<>();
    for (String typeId : typeIds) {
      String owningPackage = EntityIds.packageIdOfTypeId(typeId);
      if (!whitelist.declares(owningPackage)) {
        packageIds.add(owningPackage);
      }
      String packageId = attachableParent(typeId, whitelist);
      if (packageId == null) {
        continue;
      }
      parentOf.put(typeId, packageId);
      packageIds.add(packageId);
    }

    List<Entity> stubs = new ArrayList<>();
    for (String id : packageIds) {
      // definedIn is empty BECAUSE it is external: no corpus file declares it.
      // TWithChildren is a marker (MM-2): the external types this corpus
      // referenced are recorded by their own `parent`, and the children index is
      // derived from those. Listing them here would serialize an inverse index.
      stubs.add(
          Entity.builder(id, PACKAGE_STUB_KIND)
              .named(packageName(id))
              .definedIn(List.of(), true)
              .marker(TraitName.TWithChildren)
              .build());
    }
    for (String id : typeIds) {
      Entity.Builder builder =
          Entity.builder(id, STUB_KIND).named(EntityIds.typeSimpleName(id)).type(true);
      String packageId = parentOf.get(id);
      if (packageId != null) {
        builder.childOf(packageId);
      }
      stubs.add(builder.build());
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

  /**
   * {@code java:<packageFqn>} — no {@code /} at all, and none of the punctuation
   * a member id carries. The default package ({@code java:<unnamed>}) is always
   * corpus-declared when it exists, so it never reaches this pass as a stub.
   */
  private static boolean isPackageShaped(String id) {
    if (!id.startsWith(EntityIds.PREFIX)) {
      return false;
    }
    String body = id.substring(EntityIds.PREFIX.length());
    return !body.isEmpty()
        && body.indexOf('/') < 0
        && body.indexOf('(') < 0
        && body.indexOf(')') < 0
        && body.indexOf('#') < 0;
  }

  /**
   * The external package a stub type belongs to, or {@code null} when it has none
   * we may honestly claim.
   *
   * <p>Two refusals, both deliberate. A type whose derived package is
   * CORPUS-DECLARED gets no parent: Spoon in noClasspath mode invents FQNs inside
   * the corpus's own packages (PLAN.md §5.2), so attaching such a phantom to the
   * real package would fold it into the corpus at module level and manufacture a
   * module self-dependency out of a type that does not exist. A type in the
   * UNNAMED package gets none either — that bucket holds the primitives
   * ({@code java:<unnamed>/int}), which genuinely have no module, and attaching
   * them to a corpus default package would count {@code int} as internal.
   *
   * <p>Both cases leave the stub parentless, which the analyzer reports as
   * unplaceable at module level rather than silently mislabelling its granularity.
   */
  private static String attachableParent(String typeId, CorpusWhitelist whitelist) {
    String packageId = EntityIds.packageIdOfTypeId(typeId);
    if (packageId.equals(EntityIds.PREFIX + EntityIds.UNNAMED_PACKAGE)) {
      return null;
    }
    return whitelist.declares(packageId) ? null : packageId;
  }

  /** A package entity's TNamed name is its full dotted FQN, as pass 2 emits it. */
  private static String packageName(String id) {
    return id.substring(EntityIds.PREFIX.length());
  }
}
