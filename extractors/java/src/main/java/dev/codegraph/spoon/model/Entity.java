package dev.codegraph.spoon.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.EnumSet;
import java.util.List;

/**
 * A node: an id, a profile-defined kind, and a sum of traits (METAMODEL.md §2).
 * There is no entity hierarchy — capabilities compose as traits.
 *
 * <p><b>THE RULE this class exists to protect:</b> every trait in {@code traits}
 * must contribute its key, and no key may appear without its trait. The schema
 * enforces it (one {@code if/then} per key-contributing trait) and will reject
 * the whole model on violation; the {@link Builder} makes violating it awkward
 * by refusing to set a key and its trait separately: {@code named(x)} sets
 * {@code TNamed} <i>and</i> {@code name}, and {@link Builder#marker} accepts
 * only traits that contribute no key.
 *
 * <p>{@code TWithChildren} is a MARKER here (MM-2): {@code children} is the exact
 * inverse of {@code parent}, and inverse indexes are derived by the consumer,
 * never serialized. The trait still says "this entity is a container".
 *
 * <p>Absent keys are OMITTED, never emitted as {@code null}: {@code "name": null}
 * violates the contract. Hence {@code NON_NULL} inclusion here as well as on the
 * writer's mapper.
 *
 * <p>The Java profile does not declare {@code space}, so this record has no
 * {@code space} component at all — the key is unrepresentable rather than
 * merely discouraged.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({
  "id",
  "kind",
  "traits",
  "name",
  "signature",
  "declaredType",
  "isStub",
  "parent",
  "attachedTo",
  "parameters",
  "localVariables",
  "definedIn",
  "comments",
  "anchor"
})
public record Entity(
    String id,
    String kind,
    List<TraitName> traits,
    String name,
    String signature,
    String declaredType,
    @JsonProperty("isStub") Boolean isStub,
    String parent,
    String attachedTo,
    List<String> parameters,
    List<String> localVariables,
    List<String> definedIn,
    List<String> comments,
    SourceAnchor anchor) {

  public static Builder builder(String id, String kind) {
    return new Builder(id, kind);
  }

  /**
   * Builds an entity whose trait list cannot drift from the keys it sets. Each
   * key-contributing trait has exactly one method, which sets both.
   */
  public static final class Builder {
    private final String id;
    private final String kind;
    private final EnumSet<TraitName> traits = EnumSet.noneOf(TraitName.class);

    private String name;
    private String signature;
    private String declaredType;
    private Boolean isStub;
    private String parent;
    private String attachedTo;
    private List<String> parameters;
    private List<String> localVariables;
    private List<String> definedIn;
    private List<String> comments;
    private SourceAnchor anchor;

    private Builder(String id, String kind) {
      this.id = requireText(id, "entity id");
      this.kind = requireText(kind, "entity kind");
    }

    /** TNamed → {@code name}. Absent for constructors, lambdas, anonymous classes. */
    public Builder named(String name) {
      this.name = requireText(name, "name");
      traits.add(TraitName.TNamed);
      return this;
    }

    /** TSourceAnchor → {@code anchor}. */
    public Builder anchoredAt(SourceAnchor anchor) {
      if (anchor == null) {
        throw new IllegalArgumentException("TSourceAnchor requires an anchor");
      }
      this.anchor = anchor;
      traits.add(TraitName.TSourceAnchor);
      return this;
    }

    /** TComment → {@code comments}. */
    public Builder commented(List<String> comments) {
      this.comments = List.copyOf(comments);
      traits.add(TraitName.TComment);
      return this;
    }

    /** TChildOf → {@code parent} (lexical containment, upward). */
    public Builder childOf(String parentId) {
      this.parent = requireText(parentId, "parent");
      traits.add(TraitName.TChildOf);
      return this;
    }

    /** TAttachedTo → {@code attachedTo} (semantic attachment; unused by Java). */
    public Builder attachedTo(String entityId) {
      this.attachedTo = requireText(entityId, "attachedTo");
      traits.add(TraitName.TAttachedTo);
      return this;
    }

    /**
     * TModule → {@code definedIn} (the files a package is declared across) and
     * {@code isStub}. A package the corpus never declares is degraded exactly as
     * an external type is: no files, {@code isStub: true}. Without it the
     * module-level import layer (METAMODEL.md §9) could not close, because an
     * {@code import java.util.List} names a package no corpus file declares.
     */
    public Builder definedIn(List<String> files, boolean stub) {
      this.definedIn = List.copyOf(files);
      this.isStub = stub;
      traits.add(TraitName.TModule);
      return this;
    }

    /** TType → {@code isStub}. {@code true} means "referenced, not declared here". */
    public Builder type(boolean stub) {
      this.isStub = stub;
      traits.add(TraitName.TType);
      return this;
    }

    /**
     * TTypedEntity → {@code declaredType}. The value is optional even when the
     * trait is present (METAMODEL.md §3.4), so {@code null} is legal and means
     * "typed, but the type is not expressible" — e.g. a {@code void} return.
     */
    public Builder typed(String declaredTypeId) {
      this.declaredType = blankToNull(declaredTypeId);
      traits.add(TraitName.TTypedEntity);
      return this;
    }

    /** TInvocable → {@code signature}. Part of identity for overloads. */
    public Builder invocable(String signature) {
      if (signature == null) {
        throw new IllegalArgumentException("TInvocable requires a signature");
      }
      this.signature = signature;
      traits.add(TraitName.TInvocable);
      return this;
    }

    /** TWithParameters → {@code parameters} (ordered entity ids). */
    public Builder withParameters(List<String> parameterIds) {
      this.parameters = List.copyOf(parameterIds);
      traits.add(TraitName.TWithParameters);
      return this;
    }

    /** TWithLocalVariables → {@code localVariables}. */
    public Builder withLocalVariables(List<String> localVariableIds) {
      this.localVariables = List.copyOf(localVariableIds);
      traits.add(TraitName.TWithLocalVariables);
      return this;
    }

    /**
     * Adds a marker trait — one that contributes no key because its data lives
     * in {@code edges[]}. Key-contributing traits are rejected here on purpose:
     * they may only be added by the method that also supplies the key.
     */
    public Builder marker(TraitName trait) {
      if (!trait.isMarker()) {
        throw new IllegalArgumentException(
            trait + " contributes a key — add it with the builder method that sets that key");
      }
      traits.add(trait);
      return this;
    }

    public Builder markers(TraitName... markerTraits) {
      for (TraitName t : markerTraits) {
        marker(t);
      }
      return this;
    }

    public Entity build() {
      // EnumSet iterates in declaration order: the trait list is canonical and
      // identical for two entities carrying the same traits, whatever the order
      // the extractor happened to call the builder in. That is one half of
      // byte-identical output; sorting entities by id is the other.
      return new Entity(
          id,
          kind,
          List.copyOf(traits.stream().toList()),
          name,
          signature,
          declaredType,
          isStub,
          parent,
          attachedTo,
          parameters,
          localVariables,
          definedIn,
          comments,
          anchor);
    }

    private static String requireText(String value, String what) {
      if (value == null || value.isBlank()) {
        throw new IllegalArgumentException(what + " must be non-blank");
      }
      return value;
    }

    private static String blankToNull(String value) {
      return (value == null || value.isBlank()) ? null : value;
    }
  }

  /**
   * METAMODEL.md §6: a stub is any entity declaring TType or TModule with
   * {@code isStub: true} — the two traits that contribute the key.
   */
  public boolean stub() {
    return Boolean.TRUE.equals(isStub);
  }
}
