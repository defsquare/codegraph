package dev.codegraph.spoon;

import dev.codegraph.spoon.model.Entity;
import dev.codegraph.spoon.model.SourceAnchor;
import dev.codegraph.spoon.model.TraitName;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import spoon.reflect.CtModel;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.declaration.CtAnnotationType;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtEnum;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtInterface;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtPackage;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeParameter;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.visitor.filter.TypeFilter;

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
 * <p><b>Containment agrees in both directions.</b> {@code TChildOf} is assigned
 * during the walk, and every {@code TWithChildren} list is then computed as
 * <i>exactly</i> the ids whose parent is that entity — so the two can never
 * drift (METAMODEL.md §3.2). Only packages and named types carry
 * {@code TWithChildren} in the Java profile, so containment below a method
 * (its parameters, locals and lambdas) is recorded upward only; the analyzer
 * derives the inverse, as it does for every other relation.
 *
 * <p><b>Traversal.</b> {@code model.getAllTypes()} returns top-level types only
 * (measured: a corpus declaring {@code OrderService.Inner} yields exactly one
 * type), so types are collected by recursing {@link CtType#getNestedTypes()}
 * <i>and</i> by scanning the model for {@link CtType} elements — the scan is
 * what reaches local and anonymous classes, which are nested in a block or an
 * expression rather than in a type. {@link CtTypeParameter} is a {@code CtType}
 * in Spoon and is excluded: a {@code T} is not an entity, it erases to its bound.
 *
 * <p><b>Implicit members are emitted</b> (a record's component accessors and
 * fields, a class's default constructor), anchored at the nearest enclosing
 * positioned element, because they are real members that invocation edges land
 * on: dropping them would turn every {@code new Foo()} and {@code point.x()}
 * into a dangling reference and then into a fabricated stub.
 *
 * <p><b>Known gap:</b> a local variable declared directly in a static or instance
 * initializer block is not emitted. The id scheme hangs a local off an executable
 * id and an initializer block is not an entity of the Java profile, so the only
 * available owner would be the type — a shape no other pass would reproduce. A
 * lambda in such a block IS emitted: its id hangs off the enclosing named type by
 * design ({@link EntityIds#forLambda}).
 *
 * <p>The whitelist is not consulted here: this pass only walks declarations, so
 * everything it emits is by construction corpus-declared. Membership matters to
 * the passes that look at <i>references</i> (3 and 4).
 */
public final class EntityExtractor {

  // The Java profile's kind names (packages/core/src/profiles/java.ts). Note
  // `attribute` for a field, and that the kind — not a class/interface family —
  // decides the trait set: an interface never implements, an enum never extends.
  private static final String PACKAGE = "package";
  private static final String CLASS = "class";
  private static final String INTERFACE = "interface";
  private static final String ENUM = "enum";
  private static final String RECORD = "record";
  private static final String ANNOTATION = "annotation";
  private static final String METHOD = "method";
  private static final String CONSTRUCTOR = "constructor";
  private static final String LAMBDA = "lambda";
  private static final String ATTRIBUTE = "attribute";
  private static final String PARAMETER = "parameter";
  private static final String LOCAL_VARIABLE = "localVariable";

  /** What {@link EntityIds#forTypeReference} answers when it cannot name a type. */
  private static final String UNNAMEABLE_TYPE_ID = EntityIds.forTypeReference(null);

  /** Spoon's name for the type of the {@code null} literal. Not a declarable type. */
  private static final String NULL_TYPE = "<nulltype>";

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
    return extract(model, Progress.none());
  }

  /** PASS 2, reporting one step per declared type and per lambda. */
  public List<Entity> extract(CtModel model, Progress progress) {
    return new Walk().run(model, progress);
  }

  /**
   * An entity under construction, plus the containment link it participates in.
   * {@code children} is deliberately NOT set during the walk: it is derived from
   * the {@code parentId}s once every draft exists, which is what makes
   * TWithChildren and TChildOf agree by construction rather than by discipline.
   */
  private record Draft(String id, String parentId, boolean container, Entity.Builder builder) {}

  /** One extraction; holds the per-run memo tables so {@link #extract} stays re-entrant. */
  private final class Walk {

    /** Insertion-ordered, id-keyed: the first draft for an id wins, ties are impossible to reorder. */
    private final Map<String, Draft> drafts = new LinkedHashMap<>();

    /** Id memo. Values may be null ("this element has no expressible id"), hence containsKey. */
    private final Map<CtElement, String> ids = new IdentityHashMap<>();

    List<Entity> run(CtModel model, Progress progress) {
      List<CtType<?>> types = declaredTypes(model);
      List<CtLambda<?>> lambdas = lambdas(model);
      // Both traversals are collected before the phase opens so the bar counts
      // toward a measured total rather than one it revises halfway through. The
      // unit is what is walked, not what is emitted — one type yields a whole
      // subtree of entities, so this count is not the entity count.
      try (Progress.Phase phase =
          progress.phase("entities", (long) types.size() + lambdas.size(), "types & lambdas")) {
        packages(types);
        for (CtType<?> type : types) {
          type(type);
          phase.step();
        }
        for (CtLambda<?> lambda : lambdas) {
          lambda(lambda);
          phase.step();
        }
      }
      pruneOrphans();
      return build();
    }

    // ------------------------------------------------------------- traversal

    /** Every type the corpus declares, sorted by id: nested, local and anonymous included. */
    private List<CtType<?>> declaredTypes(CtModel model) {
      List<CtType<?>> candidates = new ArrayList<>();
      for (CtType<?> top : model.getAllTypes()) {
        collectNested(top, candidates);
      }
      candidates.addAll(model.getElements(new TypeFilter<>(CtType.class)));

      Map<String, CtType<?>> byId = new TreeMap<>();
      for (CtType<?> type : sortedByPosition(candidates, this::idOfType)) {
        String id = idOfType(type);
        if (id != null) {
          byId.putIfAbsent(id, type);
        }
      }
      return List.copyOf(byId.values());
    }

    private void collectNested(CtType<?> type, List<CtType<?>> out) {
      out.add(type);
      for (CtType<?> nested : type.getNestedTypes()) {
        collectNested(nested, out);
      }
    }

    private List<CtLambda<?>> lambdas(CtModel model) {
      List<CtLambda<?>> found = new ArrayList<>(model.getElements(new TypeFilter<>(CtLambda.class)));
      return sortedByPosition(found, this::idOfLambda);
    }

    private void packages(List<CtType<?>> types) {
      Map<String, String> names = new TreeMap<>();
      Map<String, CtPackage> declared = new TreeMap<>();
      Map<String, Set<String>> files = new TreeMap<>();
      for (CtType<?> type : types) {
        // A package's members are the types written directly in it; a nested,
        // local or anonymous class is a child of what encloses it, not of the
        // package, so it must not appear twice in the containment tree.
        if (type.getDeclaringType() != null || isAnonymous(type)) {
          continue;
        }
        CtPackage pkg = type.getPackage();
        String id = EntityIds.forPackage(pkg);
        names.putIfAbsent(id, packageName(pkg));
        declared.putIfAbsent(id, pkg);
        String file = anchors.relativeFile(type);
        if (file != null) {
          files.computeIfAbsent(id, key -> new TreeSet<>()).add(file);
        }
      }
      for (Map.Entry<String, String> entry : names.entrySet()) {
        String id = entry.getKey();
        // Package containment is walked STRUCTURALLY on Spoon's package tree,
        // never derived from the dotted name: the parent is the nearest
        // ancestor package that itself holds corpus types. A pure namespace
        // prefix (`com`, `org.apache`) is not invented as an entity, so the
        // chain skips it and the topmost populated packages stay roots.
        String parent = nearestDeclaredAncestor(declared.get(id), names.keySet());
        Entity.Builder builder =
            Entity.builder(id, PACKAGE)
                .named(entry.getValue())
                // Pass 2 only ever emits packages a corpus type is written in,
                // so these are declared by construction; pass 4 makes the stubs.
                .definedIn(List.copyOf(files.getOrDefault(id, Set.of())), false);
        if (parent != null) {
          builder.childOf(parent);
        }
        add(new Draft(id, parent, true, builder));
      }
    }

    /** Nearest enclosing package (by Spoon structure) whose id is in {@code emitted}. */
    private static String nearestDeclaredAncestor(CtPackage pkg, Set<String> emitted) {
      for (CtElement up = pkg == null ? null : pkg.getParent();
          up instanceof CtPackage ancestor && !ancestor.isUnnamedPackage();
          up = ancestor.getParent()) {
        String id = EntityIds.forPackage(ancestor);
        if (emitted.contains(id)) {
          return id;
        }
      }
      return null;
    }

    private void type(CtType<?> type) {
      String id = idOfType(type);
      String parent = containerIdOf(type);
      Optional<SourceAnchor> anchor = anchors.orEnclosing(type);
      // A type kind requires TChildOf and TSourceAnchor: without a container or
      // without evidence the entity is not representable, and inventing either
      // is worse than omitting the type.
      if (id == null || parent == null || anchor.isEmpty()) {
        return;
      }

      if (isAnonymous(type)) {
        anonymousClass((CtClass<?>) type, id, parent, anchor.get());
      } else {
        String kind = kindOf(type);
        Entity.Builder builder =
            Entity.builder(id, kind)
                .named(sourceName(type))
                .type(false)
                .childOf(parent)
                .anchoredAt(anchor.get())
                .markers(typeMarkers(kind));
        comments(builder, type);
        add(new Draft(id, parent, true, builder));
      }
      members(type, id);
    }

    /** An anonymous class is `lambda`-kind: invocable, nameless, keyed by (file, line). */
    private void anonymousClass(CtClass<?> type, String id, String parent, SourceAnchor anchor) {
      Entity.Builder builder =
          Entity.builder(id, LAMBDA)
              .invocable(anonymousSignature(type))
              .withParameters(List.of())
              .withLocalVariables(List.of())
              .markers(TraitName.TWithInvocations, TraitName.TWithAccesses)
              .childOf(parent)
              .anchoredAt(anchor);
      // A container like any type: its own methods and fields claim it as parent.
      add(new Draft(id, parent, true, builder));
    }

    /** Fields, constructors and methods of a type — including an anonymous one. */
    private void members(CtType<?> type, String ownerId) {
      for (CtField<?> field : type.getFields()) {
        field(field, ownerId);
      }
      if (type instanceof CtClass<?> declaringClass) {
        for (CtConstructor<?> constructor :
            sortedById(declaringClass.getConstructors(), c -> EntityIds.forConstructorIn(ownerId, c))) {
          constructor(constructor, ownerId);
        }
      }
      for (CtMethod<?> method :
          sortedById(type.getMethods(), m -> EntityIds.forMethodIn(ownerId, m))) {
        method(method, ownerId);
      }
    }

    private void method(CtMethod<?> method, String ownerId) {
      String id = EntityIds.forMethodIn(ownerId, method);
      Optional<SourceAnchor> anchor = anchors.orEnclosing(method);
      if (anchor.isEmpty()) {
        return;
      }
      Entity.Builder builder =
          Entity.builder(id, METHOD)
              .named(method.getSimpleName())
              .invocable(EntityIds.signatureOf(method))
              .withParameters(parameters(method, id))
              .withLocalVariables(locals(method, id))
              .markers(TraitName.TWithInvocations, TraitName.TWithAccesses)
              .typed(declaredTypeIdOf(method.getType()))
              .childOf(ownerId)
              .anchoredAt(anchor.get());
      comments(builder, method);
      add(new Draft(id, ownerId, true, builder));
    }

    private void constructor(CtConstructor<?> constructor, String ownerId) {
      String id = EntityIds.forConstructorIn(ownerId, constructor);
      Optional<SourceAnchor> anchor = anchors.orEnclosing(constructor);
      if (anchor.isEmpty()) {
        return;
      }
      // No TNamed (a constructor has no own name) and no TTypedEntity (no return
      // type): the signature alone disambiguates it.
      Entity.Builder builder =
          Entity.builder(id, CONSTRUCTOR)
              .invocable(EntityIds.signatureOf(constructor))
              .withParameters(parameters(constructor, id))
              .withLocalVariables(locals(constructor, id))
              .markers(TraitName.TWithInvocations, TraitName.TWithAccesses)
              .childOf(ownerId)
              .anchoredAt(anchor.get());
      comments(builder, constructor);
      add(new Draft(id, ownerId, true, builder));
    }

    private void lambda(CtLambda<?> lambda) {
      String id = idOfLambda(lambda);
      String parent = containerIdOf(lambda);
      Optional<SourceAnchor> anchor = anchors.of(lambda);
      if (id == null || parent == null || anchor.isEmpty()) {
        return;
      }
      Entity.Builder builder =
          Entity.builder(id, LAMBDA)
              .invocable(EntityIds.signatureOf(lambda))
              .withParameters(parameters(lambda, id))
              .withLocalVariables(locals(lambda, id))
              .markers(TraitName.TWithInvocations, TraitName.TWithAccesses)
              .childOf(parent)
              .anchoredAt(anchor.get());
      add(new Draft(id, parent, true, builder));
    }

    private void field(CtField<?> field, String ownerId) {
      String id = EntityIds.forFieldIn(ownerId, field);
      Optional<SourceAnchor> anchor = anchors.orEnclosing(field);
      if (anchor.isEmpty()) {
        return;
      }
      Entity.Builder builder =
          Entity.builder(id, ATTRIBUTE)
              .named(field.getSimpleName())
              .marker(TraitName.TStructural)
              .typed(declaredTypeIdOf(field.getType()))
              .childOf(ownerId)
              .anchoredAt(anchor.get());
      comments(builder, field);
      add(new Draft(id, ownerId, false, builder));
    }

    /** Ordered, as TWithParameters requires. */
    private List<String> parameters(CtExecutable<?> executable, String executableId) {
      List<String> ordered = new ArrayList<>();
      for (CtParameter<?> parameter : executable.getParameters()) {
        String name = parameter.getSimpleName();
        if (name == null || name.isBlank()) {
          continue;
        }
        String id = EntityIds.forParameterOf(executableId, name);
        Entity.Builder builder =
            Entity.builder(id, PARAMETER)
                .named(name)
                .marker(TraitName.TStructural)
                .typed(declaredTypeIdOf(parameter.getType()))
                .childOf(executableId);
        anchors.of(parameter).ifPresent(builder::anchoredAt);
        add(new Draft(id, executableId, false, builder));
        if (!ordered.contains(id)) {
          ordered.add(id);
        }
      }
      return ordered;
    }

    /**
     * Locals declared directly in this executable — a local inside a nested
     * lambda or anonymous-class method belongs to that inner executable, so the
     * subtree scan is filtered by container rather than trusted wholesale.
     */
    private List<String> locals(CtExecutable<?> executable, String executableId) {
      Set<String> ordered = new LinkedHashSet<>();
      for (CtLocalVariable<?> local : executable.getElements(new TypeFilter<>(CtLocalVariable.class))) {
        if (!executableId.equals(containerIdOf(local))) {
          continue;
        }
        String name = local.getSimpleName();
        Optional<SourceAnchor> anchor = anchors.of(local);
        // The id needs a 1-based line to survive shadowing and we never invent one.
        if (name == null || name.isBlank() || anchor.isEmpty()) {
          continue;
        }
        String id = EntityIds.forLocalVariableOf(executableId, name, anchor.get().startLine());
        Entity.Builder builder =
            Entity.builder(id, LOCAL_VARIABLE)
                .named(name)
                .marker(TraitName.TStructural)
                .typed(declaredTypeIdOf(local.getType()))
                .childOf(executableId)
                .anchoredAt(anchor.get());
        add(new Draft(id, executableId, false, builder));
        ordered.add(id);
      }
      return List.copyOf(ordered);
    }

    // -------------------------------------------------------------------- ids

    private String idOfType(CtType<?> type) {
      if (type == null || type instanceof CtTypeParameter) {
        return null;
      }
      if (ids.containsKey(type)) {
        return ids.get(type);
      }
      String id = null;
      if (isAnonymous(type)) {
        String file = anchors.relativeFile(type);
        if (file != null) {
          id = EntityIds.forAnonymousClass((CtClass<?>) type, file);
        }
      } else {
        id = EntityIds.forType(type);
      }
      ids.put(type, id);
      return id;
    }

    private String idOfLambda(CtLambda<?> lambda) {
      if (ids.containsKey(lambda)) {
        return ids.get(lambda);
      }
      String file = anchors.relativeFile(lambda);
      String id = file == null ? null : EntityIds.forLambda(lambda, file);
      ids.put(lambda, id);
      return id;
    }

    private String idOfMethod(CtMethod<?> method) {
      String owner = idOfType(method.getDeclaringType());
      return owner == null ? null : EntityIds.forMethodIn(owner, method);
    }

    private String idOfConstructor(CtConstructor<?> constructor) {
      String owner = idOfType(constructor.getDeclaringType());
      return owner == null ? null : EntityIds.forConstructorIn(owner, constructor);
    }

    /**
     * Id of the nearest enclosing entity that can own others: a type or a named
     * executable. Fields, locals and initializer blocks are transparent — a
     * lambda in a field initializer is a child of the type, which keeps the
     * containment tree made of entities that actually exist.
     */
    private String containerIdOf(CtElement element) {
      CtElement current = element;
      for (int guard = 0; guard < 256; guard++) {
        if (current == null || !current.isParentInitialized()) {
          return null;
        }
        CtElement parent = current.getParent();
        if (parent == null) {
          return null;
        }
        if (parent instanceof CtTypeParameter) {
          return null;
        }
        if (parent instanceof CtType<?> type) {
          return idOfType(type);
        }
        if (parent instanceof CtMethod<?> method) {
          return idOfMethod(method);
        }
        if (parent instanceof CtConstructor<?> constructor) {
          return idOfConstructor(constructor);
        }
        if (parent instanceof CtLambda<?> lambda) {
          return idOfLambda(lambda);
        }
        if (parent instanceof CtPackage pkg) {
          return EntityIds.forPackage(pkg);
        }
        current = parent;
      }
      return null;
    }

    // ---------------------------------------------------------------- output

    private void add(Draft draft) {
      drafts.putIfAbsent(draft.id(), draft);
    }

    /**
     * Drops entities whose parent was not emitted, transitively. A {@code parent}
     * pointing at an id no entity carries is a dangling reference: pass 4 would
     * turn it into a fabricated external type, so it must not leave this pass.
     */
    private void pruneOrphans() {
      boolean changed = true;
      while (changed) {
        changed = false;
        for (Draft draft : List.copyOf(drafts.values())) {
          if (draft.parentId() != null && !drafts.containsKey(draft.parentId())) {
            drafts.remove(draft.id());
            changed = true;
          }
        }
      }
    }

    private List<Entity> build() {
      List<Entity> entities = new ArrayList<>(drafts.size());
      for (Draft draft : drafts.values()) {
        if (draft.container()) {
          // TWithChildren is a marker (MM-2): only `parent` is observed, and the
          // children index is derived from it. Emitting both directions was an
          // inverse index on the wire, which invariant 4 has always forbidden.
          draft.builder().marker(TraitName.TWithChildren);
        }
        entities.add(draft.builder().build());
      }
      entities.sort(Comparator.comparing(Entity::id));
      return List.copyOf(entities);
    }

    // --------------------------------------------------------------- helpers

    /**
     * Sorts by id, then by where the element was written. The tiebreak matters
     * only when a corpus declares the same id twice (a duplicated file): without
     * it, which declaration wins would depend on Spoon's iteration order.
     */
    private <T extends CtElement> List<T> sortedByPosition(
        List<T> elements, java.util.function.Function<T, String> id) {
      List<T> sorted = new ArrayList<>(elements);
      sorted.sort(
          Comparator.<T, String>comparing(e -> nullToEmpty(id.apply(e)))
              .thenComparing(e -> nullToEmpty(anchors.relativeFile(e)))
              .thenComparingInt(this::startLineOrZero));
      return sorted;
    }

    private int startLineOrZero(CtElement element) {
      return anchors.of(element).map(SourceAnchor::startLine).orElse(0);
    }

    private <T> List<T> sortedById(
        java.util.Collection<? extends T> elements, java.util.function.Function<T, String> id) {
      List<T> sorted = new ArrayList<>(elements);
      sorted.sort(Comparator.comparing(e -> nullToEmpty(id.apply(e))));
      return sorted;
    }
  }

  // ----------------------------------------------------------------- mapping

  private static String kindOf(CtType<?> type) {
    if (type instanceof CtAnnotationType<?>) {
      return ANNOTATION;
    }
    if (type instanceof CtEnum<?>) {
      return ENUM;
    }
    if (type instanceof CtRecord) {
      return RECORD;
    }
    if (type instanceof CtInterface<?>) {
      return INTERFACE;
    }
    return CLASS;
  }

  /**
   * The marker traits a type kind carries — absence is profile information, not
   * a gap: an interface never implements, an enum/record never extends, an
   * annotation does neither (packages/core/src/profiles/java.ts).
   */
  private static TraitName[] typeMarkers(String kind) {
    return switch (kind) {
      case CLASS -> new TraitName[] {TraitName.TWithInheritances, TraitName.TWithImplements};
      case INTERFACE -> new TraitName[] {TraitName.TWithInheritances};
      case ENUM, RECORD -> new TraitName[] {TraitName.TWithImplements};
      default -> new TraitName[] {};
    };
  }

  /**
   * TTypedEntity's {@code declaredType}, or null when the type cannot be named.
   *
   * <p>The rule: emit the id of any type Spoon could name, <b>even one the corpus
   * does not declare</b> — that is a real external type and pass 4 synthesizes
   * its stub, so the link survives. Omit it only when there is nothing to name.
   * The value is optional even when the trait is present (METAMODEL.md §3.4), so
   * omitting is legal, and lossless. Three cases have nothing to name:
   *
   * <ul>
   *   <li>{@code void} — the absence of a type, not a type;
   *   <li>a PRIMITIVE ({@code int}, {@code long}, {@code boolean}…) and
   *       {@code <nulltype>}, the type Spoon gives the {@code null} literal. These
   *       are named, so they would flow to pass 4 as {@code java:<unnamed>/int}
   *       and be fabricated into stub <i>classes</i> called "int". A primitive is
   *       not an entity in any language's profile, and a phantom class named
   *       {@code int} with a fan-in of hundreds would distort every coupling
   *       metric the analyzer computes. {@link EntityIds#erasedTypeName}
   *       deliberately keeps primitives as-is, so this filter cannot live there.
   *       The test is applied to {@link EntityIds#elementTypeOf} — the type the
   *       id will name — not to the reference: {@code int[]} is not primitive but
   *       its id is {@code java:<unnamed>/int};
   *   <li>a reference Spoon could not name at all, which would otherwise be
   *       emitted as an invented id — the laundering PLAN.md §5.2 forbids.
   * </ul>
   */
  private static String declaredTypeIdOf(CtTypeReference<?> reference) {
    if (reference == null) {
      return null;
    }
    // Ask the question of the type the id will actually name. `int[]` is not
    // primitive, but forTypeReference unwraps it to `int`, so testing the
    // reference itself let `java:<unnamed>/int` through — measured on
    // commons-lang: 8 primitive stub classes with a fan-in of 44-88 each.
    CtTypeReference<?> named = EntityIds.elementTypeOf(reference);
    if (named == null) {
      return EntityIds.forTypeReference(reference); // unbounded type variable → Object
    }
    if (named.isPrimitive() || NULL_TYPE.equals(named.getSimpleName())) {
      return null;
    }
    String id = EntityIds.forTypeReference(reference);
    return UNNAMEABLE_TYPE_ID.equals(id) ? null : id;
  }

  private static void comments(Entity.Builder builder, CtElement element) {
    String doc = element.getDocComment();
    if (doc != null && !doc.isBlank()) {
      builder.commented(List.of(doc.strip()));
    }
  }

  private static boolean isAnonymous(CtType<?> type) {
    return type instanceof CtClass<?> declaringClass && declaringClass.isAnonymous();
  }

  private static String packageName(CtPackage pkg) {
    if (pkg == null || pkg.isUnnamedPackage() || pkg.getQualifiedName().isBlank()) {
      return EntityIds.UNNAMED_PACKAGE;
    }
    return pkg.getQualifiedName();
  }

  /**
   * TNamed's {@code name}: the name as written. Spoon prefixes a local class's
   * simple name with the JVM disambiguator ({@code 1Local}); the id keeps
   * Spoon's form — ids must not be prettified — but the name does not.
   */
  private static String sourceName(CtType<?> type) {
    String simple = type.getSimpleName();
    int digits = 0;
    while (digits < simple.length() && Character.isDigit(simple.charAt(digits))) {
      digits++;
    }
    return digits < simple.length() ? simple.substring(digits) : simple;
  }

  /**
   * An anonymous class has no signature of its own; TInvocable requires one, so
   * it is named after what it instantiates — {@code new Runnable(){…}} yields
   * {@code java.lang.Runnable()}.
   */
  private static String anonymousSignature(CtClass<?> type) {
    CtTypeReference<?> instantiated = type.getSuperclass();
    if (instantiated == null) {
      instantiated =
          type.getSuperInterfaces().stream()
              .min(Comparator.comparing(EntityIds::erasedTypeName))
              .orElse(null);
    }
    return (instantiated == null ? "java.lang.Object" : EntityIds.erasedTypeName(instantiated)) + "()";
  }

  private static String nullToEmpty(String value) {
    return value == null ? "" : value;
  }
}
