package dev.codegraph.spoon;

import java.util.Collection;
import java.util.Set;
import java.util.TreeSet;
import spoon.reflect.CtModel;

/**
 * PASS 1 — the set of ids the corpus actually DECLARES. Everything downstream
 * asks this one question: "is this id declared here, or is it external?"
 *
 * <p><b>This is the central safeguard of M2</b> (PLAN.md §5.2, METAMODEL.md §6).
 * Spoon in noClasspath mode invents fully-qualified names by assuming the
 * enclosing package: over a corpus whose only file declares
 * {@code com.acme.order.OrderService}, it reported references to
 * {@code com.acme.order.Order} and {@code com.acme.order.Invoice} — classes that
 * exist nowhere. A package-prefix filter would classify those fabrications as
 * internal corpus types and launder them into facts. Membership is decided ONLY
 * by this whitelist, never by a prefix, never by the shape of an id.
 *
 * <p>Implementation notes for whoever fills {@link #build} in:
 * <ul>
 *   <li>{@code model.getAllTypes()} does NOT return nested types — measured: a
 *       corpus declaring {@code OrderService.Inner} yielded exactly one type.
 *       Recurse through {@link spoon.reflect.declaration.CtType#getNestedTypes()}
 *       or the whitelist silently omits every inner class, and every inner class
 *       then degrades into a stub.
 *   <li>Members count too: methods, constructors, fields, parameters, locals,
 *       lambdas and anonymous classes are declared by the corpus and their ids
 *       are legitimate edge targets.
 *   <li>Packages count: an {@code import} edge targets a package id.
 *   <li>Ids come from {@link EntityIds} and nowhere else — an id built by hand
 *       here that disagrees with the one the entity pass emits produces a
 *       dangling edge that the analyzer's closure property will catch.
 * </ul>
 */
public final class CorpusWhitelist {

  private final Set<String> declaredIds;

  private CorpusWhitelist(Collection<String> declaredIds) {
    // Sorted + immutable: no HashSet iteration order may reach the output.
    this.declaredIds = Set.copyOf(new TreeSet<>(declaredIds));
  }

  /**
   * PASS 1. Walks the whole model and collects the ids it declares.
   *
   * @return an immutable whitelist; {@link #ids()} is the immutable
   *     {@code Set<String>} of declared ids
   */
  public static CorpusWhitelist build(CtModel model) {
    throw new UnsupportedOperationException("M2: the whitelist agent fills this in");
  }

  /** Escape hatch for tests and for callers that already have the id set. */
  public static CorpusWhitelist of(Collection<String> declaredIds) {
    return new CorpusWhitelist(declaredIds);
  }

  /** The declared ids, immutable and sorted. */
  public Set<String> ids() {
    return declaredIds;
  }

  /** THE membership question. The only legitimate way to ask it. */
  public boolean declares(String id) {
    return declaredIds.contains(id);
  }

  public int size() {
    return declaredIds.size();
  }
}
