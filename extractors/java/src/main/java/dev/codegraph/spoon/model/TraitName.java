package dev.codegraph.spoon.model;

/**
 * The closed, canonical trait vocabulary (METAMODEL.md §3). Constant names are
 * the JSON values verbatim — never rename or alias them locally.
 *
 * <p>Declaration order is load-bearing: entity trait lists are emitted in
 * ordinal order (via {@link java.util.EnumSet}), which is what makes two runs
 * over the same corpus byte-identical.
 */
public enum TraitName {
  TNamed,
  TSourceAnchor,
  TComment,
  TWithChildren,
  TChildOf,
  TAttachedTo,
  TModule,
  TType,
  TWithInheritances,
  TWithImplements,
  TTypedEntity,
  TInvocable,
  TWithParameters,
  TWithLocalVariables,
  TWithInvocations,
  TStructural,
  TWithAccesses,
  TMetrics,
  TWithValue;

  /**
   * Marker traits contribute no attribute: their data lives in {@code edges[]}
   * (METAMODEL.md §3). They are the only traits {@link Entity.Builder#marker}
   * accepts — every key-contributing trait must be added by the builder method
   * that also supplies its key.
   */
  public boolean isMarker() {
    return switch (this) {
      case TWithChildren,
              TWithInheritances,
              TWithImplements,
              TWithInvocations,
              TStructural,
              TWithAccesses ->
          true;
      default -> false;
    };
  }
}
