package dev.codegraph.spoon;

import dev.codegraph.spoon.model.Entity;
import java.util.List;
import spoon.reflect.CtModel;

/**
 * PASS 2 — one {@link Entity} per construct the corpus declares.
 *
 * <p>The trait composition per construct is PLAN.md §5.1's mapping table and it
 * is normative:
 *
 * <pre>
 *   package      package        TNamed, TModule, TWithChildren, (TComment)
 *   class        class          TNamed, TType, TWithInheritances, TWithImplements,
 *                               TWithChildren, TChildOf, TSourceAnchor, (TComment)
 *   interface    interface      as class, but no TWithImplements
 *   enum/record  enum/record    as class, but no TWithInheritances
 *   annotation   annotation     TNamed, TType, TWithChildren, TChildOf, TSourceAnchor
 *   method       method         TNamed, TInvocable, TWithParameters, TWithLocalVariables,
 *                               TWithInvocations, TWithAccesses, TTypedEntity,
 *                               TChildOf, TSourceAnchor
 *   constructor  constructor    as method, but NO TNamed and NO TTypedEntity
 *   lambda/anon  lambda         TInvocable WITHOUT TNamed
 *   field        attribute      TNamed, TStructural, TTypedEntity, TChildOf, TSourceAnchor
 *   parameter    parameter      TNamed, TStructural, TTypedEntity, TChildOf
 *   local var    localVariable  TNamed, TStructural, TTypedEntity, TChildOf
 * </pre>
 *
 * <p>Build every entity through {@link Entity#builder} — it sets each trait
 * together with the key that trait contributes, which is the rule the schema
 * enforces. No entity may carry a {@code space} key: the Java profile does not
 * declare one (that key is not even representable on {@link Entity}).
 *
 * <p>The whitelist is available so that this pass emits entities only for what
 * the corpus declares; external types are not entities here — they are stubs,
 * synthesized in pass 4 from what was actually referenced.
 */
public final class EntityExtractor {

  private final CorpusWhitelist whitelist;
  private final Anchors anchors;

  public EntityExtractor(CorpusWhitelist whitelist, Anchors anchors) {
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
   * PASS 2. Order is irrelevant — {@code Model.sorted} sorts by id before
   * writing — but the same corpus must always yield the same set.
   */
  public List<Entity> extract(CtModel model) {
    throw new UnsupportedOperationException("M2: the entity agent fills this in");
  }
}
