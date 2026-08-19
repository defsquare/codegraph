package dev.codegraph.spoon;

import dev.codegraph.spoon.model.Edge;
import java.util.List;
import spoon.reflect.CtModel;

/**
 * PASS 3 — every relation the corpus states, in the outgoing direction only.
 *
 * <p>The Java profile licenses six edge kinds and {@link Edge} has a factory for
 * each: {@code import}, {@code inheritance}, {@code interfaceImplementation},
 * {@code invocation}, {@code access} (with {@code isRead}/{@code isWrite}) and
 * {@code reference}. Inverse views are never emitted — the analyzer derives them.
 *
 * <p>Rules this pass must hold to:
 * <ul>
 *   <li><b>Provenance is a claim about knowledge, not a formality.</b>
 *       {@code declared} means the source says so (an {@code implements} clause,
 *       a call whose target resolved). An inference is {@code derived}; an
 *       uncertain dispatch is {@code dynamic-candidate} and carries
 *       {@code candidates}. Lombok-visible members are {@code generated}.
 *   <li><b>Every edge needs an anchor.</b> Use {@link Anchors#orEnclosing} when
 *       the element itself has no valid position; if nothing up the chain has
 *       one, drop the fact rather than invent evidence.
 *   <li><b>Self-edges are dropped</b> ({@code from == to}, METAMODEL.md §4).
 *       Recursion is legal Java, so this is a filter, not an error — {@code Main}
 *       drops them and reports the count, but dropping them here is better.
 *   <li><b>DECISION — edges to members of external types target the declaring
 *       type's stub id.</b> A stub is a TType entity (METAMODEL.md §6); a
 *       degraded {@code method} stub is not representable, since only TType
 *       stubs are exempt from the profile's required-trait rule. So an
 *       invocation of {@code java.util.List.add} becomes an edge to the stub
 *       {@code java:java.util/List}: the type-level dependency survives (that is
 *       what analyses fold to anyway) and no fabricated member entity claims to
 *       exist. Whether the target type is external is decided by
 *       {@link CorpusWhitelist#declares}, never by a package prefix.
 * </ul>
 */
public final class EdgeExtractor {

  private final CorpusWhitelist whitelist;
  private final Anchors anchors;

  public EdgeExtractor(CorpusWhitelist whitelist, Anchors anchors) {
    this.whitelist = whitelist;
    this.anchors = anchors;
  }

  public CorpusWhitelist whitelist() {
    return whitelist;
  }

  public Anchors anchors() {
    return anchors;
  }

  /**
   * PASS 3. The ids this pass targets are what pass 4 turns into stubs, so a
   * target invented here becomes a stub entity that should not exist.
   */
  public List<Edge> extract(CtModel model) {
    throw new UnsupportedOperationException("M2: the edge agent fills this in");
  }
}
