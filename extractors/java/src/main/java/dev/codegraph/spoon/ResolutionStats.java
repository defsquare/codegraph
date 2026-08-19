package dev.codegraph.spoon;

import spoon.reflect.CtModel;
import spoon.reflect.reference.CtTypeParameterReference;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.visitor.filter.TypeFilter;

/**
 * The stderr RESOLUTION SUMMARY required by PLAN.md §5.3, and the number M2 is
 * judged on: the share of type references Spoon could resolve in noClasspath
 * mode (target ≥ ~85% on a real corpus).
 *
 * <p>Resolvability is measured as {@code getTypeDeclaration() != null}. That is
 * the practical signal, not corpus membership: it is also true for JDK types on
 * the classpath. Membership is {@link CorpusWhitelist}'s job and nothing else's.
 *
 * @param totalTypeReferences every {@link CtTypeReference} in the model, type
 *     variables excluded (a {@code T} is not a resolution question)
 * @param resolvedTypeReferences those with a reachable declaration
 * @param entityCount entities written, stubs included
 * @param stubCount entities with {@code isStub: true}
 * @param edgeCount edges written
 * @param droppedSelfEdges edges dropped because {@code from == to} (METAMODEL.md §4)
 */
public record ResolutionStats(
    long totalTypeReferences,
    long resolvedTypeReferences,
    int entityCount,
    int stubCount,
    int edgeCount,
    int droppedSelfEdges) {

  /** Counts type references over the whole model; the pass is read-only. */
  public static ResolutionStats measure(CtModel model) {
    long total = 0;
    long resolved = 0;
    for (CtTypeReference<?> reference :
        model.getElements(new TypeFilter<CtTypeReference<?>>(CtTypeReference.class))) {
      // A type variable has no declaration to resolve to; counting it would
      // depress the rate without naming a real blind spot.
      if (reference instanceof CtTypeParameterReference) {
        continue;
      }
      total++;
      if (reference.getTypeDeclaration() != null) {
        resolved++;
      }
    }
    return new ResolutionStats(total, resolved, 0, 0, 0, 0);
  }

  public ResolutionStats withOutput(int entityCount, int stubCount, int edgeCount, int droppedSelfEdges) {
    return new ResolutionStats(
        totalTypeReferences, resolvedTypeReferences, entityCount, stubCount, edgeCount, droppedSelfEdges);
  }

  public long unresolvedTypeReferences() {
    return totalTypeReferences - resolvedTypeReferences;
  }

  public double resolutionRate() {
    return totalTypeReferences == 0 ? 1.0 : (double) resolvedTypeReferences / totalTypeReferences;
  }

  /** Human-readable, one fact per line — this is what lands on stderr. */
  public String summary() {
    return """
        RESOLUTION SUMMARY
          type references : %d
          resolved        : %d
          unresolved      : %d
          resolution rate : %.1f%%
          entities        : %d (stubs: %d)
          edges           : %d (self-edges dropped: %d)"""
        .formatted(
            totalTypeReferences,
            resolvedTypeReferences,
            unresolvedTypeReferences(),
            resolutionRate() * 100.0,
            entityCount,
            stubCount,
            edgeCount,
            droppedSelfEdges);
  }
}
