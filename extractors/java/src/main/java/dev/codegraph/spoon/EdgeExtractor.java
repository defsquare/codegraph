package dev.codegraph.spoon;

import dev.codegraph.spoon.model.Edge;
import dev.codegraph.spoon.model.Provenance;
import dev.codegraph.spoon.model.SourceAnchor;
import java.util.ArrayList;
import java.util.Collections;
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
import java.util.function.Supplier;
import spoon.experimental.CtUnresolvedImport;
import spoon.reflect.CtModel;
import spoon.reflect.code.CtAbstractInvocation;
import spoon.reflect.code.CtAssignment;
import spoon.reflect.code.CtExecutableReferenceExpression;
import spoon.reflect.code.CtFieldAccess;
import spoon.reflect.code.CtFieldWrite;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.code.CtNewClass;
import spoon.reflect.code.CtOperatorAssignment;
import spoon.reflect.code.CtUnaryOperator;
import spoon.reflect.code.UnaryOperatorKind;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtAnnotationType;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtCompilationUnit;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtEnum;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtImport;
import spoon.reflect.declaration.CtInterface;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtPackage;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeParameter;
import spoon.reflect.reference.CtArrayTypeReference;
import spoon.reflect.reference.CtExecutableReference;
import spoon.reflect.reference.CtFieldReference;
import spoon.reflect.reference.CtPackageReference;
import spoon.reflect.reference.CtTypeMemberWildcardImportReference;
import spoon.reflect.reference.CtTypeParameterReference;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.reference.CtWildcardReference;
import spoon.reflect.visitor.filter.TypeFilter;

/**
 * PASS 3 — every relation the corpus states, in the outgoing direction only.
 *
 * <p>The Java profile licenses six edge kinds and {@link Edge} has a factory for
 * each: {@code import}, {@code inheritance}, {@code interfaceImplementation},
 * {@code invocation}, {@code access} (with {@code isRead}/{@code isWrite}) and
 * {@code reference}. Inverse views are never emitted — the analyzer derives them.
 *
 * <p>Rules this pass holds to:
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
 *
 * <p><b>Every id this pass emits — {@code from}, {@code to} and every candidate —
 * is either whitelisted or a plain type id.</b> Pass 4 turns whatever pass 3
 * referenced but pass 2 did not declare into a {@code TType} stub, so pointing an
 * edge at a member id nobody declares does not produce a dangling reference: it
 * produces a fabricated {@code class} entity named {@code bill(Order)}. That is
 * why an unresolved member is folded up to its declaring type instead
 * ({@link #targetOf}), and why {@code from} is resolved by walking outward to the
 * nearest ancestor the whitelist actually declares ({@link #ownerOf}).
 *
 * <p>Facts this pass deliberately does not state, each because the alternative
 * would be a fabrication:
 * <ul>
 *   <li><b>Implicit elements.</b> Spoon materializes {@code super()} calls,
 *       {@code this} accesses and default constructors that nobody wrote; they
 *       carry no position. They are skipped unless they are a visible Lombok
 *       expansion, which is the one case where an unwritten member is a real
 *       member — those become {@link Provenance#GENERATED}.
 *   <li><b>Inferred expression types.</b> Every Spoon expression carries a type
 *       reference (the {@code int} of {@code x += 2}), indistinguishable in the
 *       tree from a written one except by its lack of a source position. A
 *       {@code reference} edge is claimed only for a type reference that has
 *       one — evidence is the criterion.
 *   <li><b>Unidentifiable targets.</b> A call whose declaring type Spoon cannot
 *       name at all yields {@code java:&lt;unnamed&gt;/&lt;unknown&gt;}; an edge there
 *       would create one junk node that every unresolved call in the corpus
 *       points at, silently inflating coupling metrics. Dropped and counted
 *       ({@link #droppedUnidentifiedTargets()}).
 * </ul>
 */
public final class EdgeExtractor {

  /**
   * What {@link EntityIds#forTypeReference} produces for a type it cannot name.
   * An edge to it states nothing, so such edges are dropped (and counted).
   */
  static final String UNKNOWN_TYPE_ID = EntityIds.PREFIX + EntityIds.UNNAMED_PACKAGE + "/<unknown>";

  private static final String LOMBOK_PACKAGE_PREFIX = "lombok.";

  /**
   * Total order. {@link Edge#DETERMINISTIC_ORDER} is the contract's order; the
   * tie-breakers exist so that no pair of emitted edges can be left to Spoon's
   * traversal order, which is set-backed in places (imports come out shuffled).
   */
  private static final Comparator<Edge> TOTAL_ORDER =
      Edge.DETERMINISTIC_ORDER
          .thenComparing(e -> e.candidates() == null ? "" : String.join(",", e.candidates()))
          .thenComparing(e -> String.valueOf(e.isRead()))
          .thenComparing(e -> String.valueOf(e.isWrite()));

  private final CorpusWhitelist whitelist;
  private final Anchors anchors;

  // Per-run state, reset by every extract() call.
  private final Set<Edge> edges = new LinkedHashSet<>();
  private final Map<AccessKey, boolean[]> accesses = new LinkedHashMap<>();
  private final Map<String, Set<String>> directSubtypes = new TreeMap<>();
  private final Map<String, Set<String>> transitiveSubtypes = new TreeMap<>();
  private int droppedSelfReferences;
  private int droppedUnidentifiedTargets;
  private int droppedUnanchoredFacts;

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
    reset();
    List<DeclaredType> types = corpusTypes(model);
    indexSubtypes(types);

    emitImports(types);
    emitSupertypes(types);
    emitInvocations(model);
    emitMethodReferences(model);
    emitAccesses(model);
    emitAnnotations(model);
    emitTypeReferences(model);

    return assemble();
  }

  // -------------------------------------------------------------- statistics

  /** Recursion and self-referencing declarations, dropped per METAMODEL.md §4. */
  public int droppedSelfReferences() {
    return droppedSelfReferences;
  }

  /** Facts whose target Spoon could not name at all — see the class javadoc. */
  public int droppedUnidentifiedTargets() {
    return droppedUnidentifiedTargets;
  }

  /** Facts dropped for lack of evidence: nothing up the tree carried a position. */
  public int droppedUnanchoredFacts() {
    return droppedUnanchoredFacts;
  }

  // ------------------------------------------------------------------ import

  /**
   * Module → module, the layer that is comparable across languages
   * (CLAUDE.md invariant 9). {@code from} is the file's own package, which the
   * corpus declares by containing the file — it is emitted whether or not the
   * whitelist happens to list packages, because losing the import layer to a
   * pass-1 omission would be worse than a stub package node.
   */
  private void emitImports(List<DeclaredType> types) {
    Set<CtCompilationUnit> seen = Collections.newSetFromMap(new IdentityHashMap<>());
    for (DeclaredType declared : types) {
      if (!declared.type().isTopLevel()) {
        continue;
      }
      CtCompilationUnit unit = compilationUnitOf(declared.type());
      if (unit == null || !seen.add(unit)) {
        continue;
      }
      String from = EntityIds.forPackage(unit.getDeclaredPackage());
      for (CtImport statement : unit.getImports()) {
        emitImport(from, statement);
      }
    }
  }

  private void emitImport(String from, CtImport statement) {
    if (statement == null || statement.isImplicit()) {
      return;
    }
    Optional<SourceAnchor> anchor = anchors.orEnclosing(statement);
    if (anchor.isEmpty()) {
      droppedUnanchoredFacts++;
      return;
    }
    importTarget(statement).ifPresent(target -> add(Edge.importEdge(from, target.id(), target.provenance(), anchor.get())));
  }

  /**
   * The package an import statement points at.
   *
   * <p>Spoon resolves an import only when the imported type is on the classpath
   * or in the corpus; everything else — i.e. every third-party dependency in a
   * noClasspath run — arrives as a {@link CtUnresolvedImport} with a null
   * reference and only its source text. Splitting that text at the last segment
   * recovers the package for {@code a.b.C}, but {@code a.b.Outer.Inner} splits
   * one segment too late, so the package boundary is inferred, not read: those
   * edges are {@code derived}, and only the resolved ones are {@code declared}.
   */
  private Optional<ImportTarget> importTarget(CtImport statement) {
    if (statement instanceof CtUnresolvedImport unresolved) {
      return unresolvedImportTarget(unresolved);
    }
    return switch (statement.getImportKind()) {
      case TYPE ->
          statement.getReference() instanceof CtTypeReference<?> type
              ? packageOfType(type).map(id -> new ImportTarget(id, Provenance.DECLARED))
              : Optional.empty();
      case ALL_TYPES ->
          statement.getReference() instanceof CtPackageReference pkg
              ? Optional.of(new ImportTarget(EntityIds.forPackageName(pkg.getQualifiedName()), Provenance.DECLARED))
              : Optional.empty();
      case METHOD ->
          statement.getReference() instanceof CtExecutableReference<?> executable
              ? packageOfType(executable.getDeclaringType()).map(id -> new ImportTarget(id, Provenance.DECLARED))
              : Optional.empty();
      case FIELD ->
          statement.getReference() instanceof CtFieldReference<?> field
              ? packageOfType(field.getDeclaringType()).map(id -> new ImportTarget(id, Provenance.DECLARED))
              : Optional.empty();
      case ALL_STATIC_MEMBERS ->
          statement.getReference() instanceof CtTypeMemberWildcardImportReference wildcard
              ? packageOfType(wildcard.getTypeReference()).map(id -> new ImportTarget(id, Provenance.DECLARED))
              : Optional.empty();
      // UNRESOLVED is handled above; anything else Spoon may add is not a
      // module-level dependency this extractor knows how to state.
      default -> Optional.empty();
    };
  }

  private Optional<ImportTarget> unresolvedImportTarget(CtUnresolvedImport statement) {
    String text = statement.getUnresolvedReference();
    if (text == null || text.isBlank()) {
      return Optional.empty();
    }
    String name = text.trim();
    boolean onDemand = name.endsWith(".*");
    if (onDemand) {
      name = name.substring(0, name.length() - 2);
    }
    // static single-member imports name a member of a type of a package: two
    // segments to drop; a static on-demand import and a plain type import, one.
    int drop = statement.isStatic() ? (onDemand ? 1 : 2) : (onDemand ? 0 : 1);
    List<String> segments = new ArrayList<>(List.of(name.split("\\.")));
    if (segments.size() <= drop) {
      return Optional.empty();
    }
    String packageName = String.join(".", segments.subList(0, segments.size() - drop));
    if (packageName.isBlank()) {
      return Optional.empty();
    }
    return Optional.of(new ImportTarget(EntityIds.forPackageName(packageName), Provenance.DERIVED));
  }

  private Optional<String> packageOfType(CtTypeReference<?> type) {
    if (type == null) {
      return Optional.empty();
    }
    return safe(() -> EntityIds.forTypeReference(type))
        .filter(id -> !UNKNOWN_TYPE_ID.equals(id))
        .map(EntityIds::packageIdOfTypeId);
  }

  // --------------------------------------------- inheritance / implementation

  /**
   * {@code extends} and {@code implements}, keyed off the kind rather than a
   * class/interface family: an interface's {@code extends} list is inheritance
   * between types, a class/enum/record's {@code implements} list is
   * interfaceImplementation (the Java profile's note, and the reason
   * {@code interface} carries no TWithImplements).
   *
   * <p>An anonymous class states its supertype through {@code new X() {…}}, but
   * its entity kind is {@code lambda}, which carries neither TWithInheritances
   * nor TWithImplements — the marker traits announce the edges an entity may
   * have. So its supertype is recorded as a {@code reference}, which every kind
   * may carry, rather than as an inheritance claim the profile does not license.
   */
  private void emitSupertypes(List<DeclaredType> types) {
    for (DeclaredType declared : types) {
      CtType<?> type = declared.type();
      String from = declared.id();
      boolean anonymous = isAnonymous(type);

      CtTypeReference<?> superclass = type.getSuperclass();
      if (superclass != null && (!superclass.isImplicit() || anonymous) && declaresItsSuperclass(type)) {
        supertypeId(superclass)
            .ifPresent(
                to ->
                    supertypeAnchor(superclass, type)
                        .ifPresent(
                            anchor ->
                                add(
                                    anonymous
                                        ? Edge.reference(from, to, Provenance.DECLARED, anchor)
                                        : Edge.inheritance(from, to, Provenance.DECLARED, anchor))));
      }

      for (CtTypeReference<?> implemented : type.getSuperInterfaces()) {
        // An anonymous class has no written header, so Spoon marks the supertype
        // it gets from `new Runnable() {…}` implicit — but that supertype IS
        // written, at the instantiation, and it is the only thing that says what
        // the class is.
        if (implemented == null
            || (implemented.isImplicit() && !anonymous)
            || type instanceof CtAnnotationType<?>) {
          continue;
        }
        supertypeId(implemented)
            .ifPresent(
                to ->
                    supertypeAnchor(implemented, type)
                        .ifPresent(
                            anchor -> {
                              if (anonymous) {
                                add(Edge.reference(from, to, Provenance.DECLARED, anchor));
                              } else if (type instanceof CtInterface<?>) {
                                add(Edge.inheritance(from, to, Provenance.DECLARED, anchor));
                              } else {
                                add(Edge.interfaceImplementation(from, to, Provenance.DECLARED, anchor));
                              }
                            }));
      }
    }
  }

  /**
   * An enum's {@code java.lang.Enum} superclass and a record's
   * {@code java.lang.Record} are supplied by the language, not written by the
   * author — Spoon reports them at the declaration's own position, so only the
   * kind tells them apart from a real {@code extends}. The Java profile agrees:
   * {@code enum} and {@code record} carry no TWithInheritances, and an
   * {@code annotation} carries neither marker.
   */
  private static boolean declaresItsSuperclass(CtType<?> type) {
    return !(type instanceof CtEnum<?>)
        && !(type instanceof CtRecord)
        && !(type instanceof CtAnnotationType<?>);
  }

  private Optional<String> supertypeId(CtTypeReference<?> reference) {
    return safe(() -> EntityIds.forTypeReference(reference)).filter(id -> !UNKNOWN_TYPE_ID.equals(id));
  }

  /** The extends/implements clause when it has a position, else the declaration. */
  private Optional<SourceAnchor> supertypeAnchor(CtTypeReference<?> reference, CtType<?> type) {
    Optional<SourceAnchor> anchor = anchors.of(reference).or(() -> anchors.orEnclosing(type));
    if (anchor.isEmpty()) {
      droppedUnanchoredFacts++;
    }
    return anchor;
  }

  // -------------------------------------------------------------- invocation

  private void emitInvocations(CtModel model) {
    for (CtAbstractInvocation<?> invocation :
        model.getElements(new TypeFilter<CtAbstractInvocation<?>>(CtAbstractInvocation.class))) {
      CtElement site = invocation;
      Optional<Provenance> provenance = provenanceOf(site);
      if (provenance.isEmpty()) {
        continue;
      }
      CtClass<?> anonymous =
          invocation instanceof CtNewClass<?> newClass ? newClass.getAnonymousClass() : null;
      if (anonymous != null) {
        emitAnonymousInstantiation(site, anonymous, provenance.get());
        continue;
      }
      emitCall(site, invocation.getExecutable(), provenance.get());
    }
  }

  /** {@code Foo::bar} names a call site as surely as {@code foo.bar()} does. */
  private void emitMethodReferences(CtModel model) {
    for (CtExecutableReferenceExpression<?, ?> expression :
        model.getElements(
            new TypeFilter<CtExecutableReferenceExpression<?, ?>>(CtExecutableReferenceExpression.class))) {
      provenanceOf(expression)
          .ifPresent(provenance -> emitCall(expression, expression.getExecutable(), provenance));
    }
  }

  private void emitCall(CtElement site, CtExecutableReference<?> executable, Provenance provenance) {
    if (executable == null) {
      return;
    }
    Optional<Target> target = targetOf(executable);
    if (target.isEmpty()) {
      droppedUnidentifiedTargets++;
      return;
    }
    Optional<SourceAnchor> anchor = anchorOf(site);
    if (anchor.isEmpty()) {
      return;
    }
    Optional<Owner> owner = invocableOwnerOf(site);
    if (owner.isEmpty()) {
      return;
    }

    String member = target.get().memberId();
    if (!whitelist.declares(member)) {
      // The member is external (or was never resolved): fold the fact up to its
      // declaring type, the only granularity a stub can honestly represent.
      emitTypeLevelCall(owner.get(), target.get().typeId(), provenance, anchor.get());
      return;
    }
    if (owner.get().kind() != OwnerKind.INVOCABLE) {
      emitTypeLevelCall(owner.get(), target.get().typeId(), provenance, anchor.get());
      return;
    }

    List<String> candidates = candidatesFor(executable, target.get());
    Provenance effective = candidates.isEmpty() ? provenance : Provenance.DYNAMIC_CANDIDATE;
    add(Edge.invocation(owner.get().id(), member, effective, anchor.get(), candidates));
  }

  /**
   * A call whose target member is not a corpus entity, or that is written
   * outside any invocable (a field initializer, a static block): the dependency
   * on the type is the part that is still true, and {@code reference} is the
   * kind that states exactly that.
   */
  private void emitTypeLevelCall(Owner owner, String typeId, Provenance provenance, SourceAnchor anchor) {
    if (UNKNOWN_TYPE_ID.equals(typeId)) {
      droppedUnidentifiedTargets++;
      return;
    }
    if (owner.kind() == OwnerKind.INVOCABLE) {
      add(Edge.invocation(owner.id(), typeId, provenance, anchor, List.of()));
    } else {
      add(Edge.reference(owner.id(), typeId, provenance, anchor));
    }
  }

  /** {@code new Runnable() {…}} instantiates the anonymous class, which is an entity. */
  private void emitAnonymousInstantiation(CtElement site, CtClass<?> anonymous, Provenance provenance) {
    Optional<String> target = typeIdOf(anonymous).filter(whitelist::declares);
    if (target.isEmpty()) {
      // Its supertype reference already carries the dependency; inventing an id
      // for a class pass 2 did not declare would fabricate a stub.
      return;
    }
    Optional<SourceAnchor> anchor = anchorOf(site);
    Optional<Owner> owner = invocableOwnerOf(site);
    if (anchor.isEmpty() || owner.isEmpty() || owner.get().kind() != OwnerKind.INVOCABLE) {
      return;
    }
    add(Edge.invocation(owner.get().id(), target.get(), provenance, anchor.get(), List.of()));
  }

  /**
   * The corpus-declared overrides of the call's target.
   *
   * <p>METAMODEL.md §4: {@code candidates} is non-empty iff resolution was
   * ambiguous. Dispatch is ambiguous exactly when the corpus declares an
   * override of the target signature in a subtype — the static target then names
   * one of several bodies that may run. Constructors and static calls are never
   * dispatched, and a {@code private} or {@code final} method cannot be
   * overridden, so those resolve to one executable and carry no candidates.
   */
  private List<String> candidatesFor(CtExecutableReference<?> executable, Target target) {
    if (executable.isConstructor() || executable.isStatic()) {
      return List.of();
    }
    CtExecutable<?> declaration = safeDeclaration(executable);
    if (declaration instanceof CtMethod<?> method
        && (method.isPrivate() || method.isFinal() || method.isStatic())) {
      return List.of();
    }
    String signature = memberSuffix(target);
    if (signature == null) {
      return List.of();
    }
    Set<String> overrides = new TreeSet<>();
    for (String subtype : subtypesOf(target.typeId())) {
      String candidate = subtype + "." + signature;
      if (whitelist.declares(candidate)) {
        overrides.add(candidate);
      }
    }
    if (overrides.isEmpty()) {
      return List.of();
    }
    // The static target itself is a candidate unless it is known to be abstract:
    // an abstract declaration is a name, never a body that runs.
    boolean abstractTarget = declaration instanceof CtMethod<?> method && method.isAbstract();
    if (!abstractTarget) {
      overrides.add(target.memberId());
    }
    return List.copyOf(overrides);
  }

  /** {@code java:p/T.bill(p.Order)} minus its owner type: {@code bill(p.Order)}. */
  private static String memberSuffix(Target target) {
    String prefix = target.typeId() + ".";
    return target.memberId().startsWith(prefix) ? target.memberId().substring(prefix.length()) : null;
  }

  // ------------------------------------------------------------------ access

  private void emitAccesses(CtModel model) {
    for (CtFieldAccess<?> access :
        model.getElements(new TypeFilter<CtFieldAccess<?>>(CtFieldAccess.class))) {
      Optional<Provenance> provenance = provenanceOf(access);
      if (provenance.isEmpty()) {
        continue;
      }
      CtFieldReference<?> field = access.getVariable();
      if (field == null) {
        continue;
      }
      Optional<String> member = safe(() -> EntityIds.forFieldReference(field));
      Optional<String> ownerType =
          field.getDeclaringType() == null
              ? Optional.empty()
              : safe(() -> EntityIds.forTypeReference(field.getDeclaringType()));
      if (member.isEmpty()) {
        droppedUnidentifiedTargets++;
        continue;
      }
      Optional<SourceAnchor> anchor = anchorOf(access);
      Optional<Owner> owner = invocableOwnerOf(access);
      if (anchor.isEmpty() || owner.isEmpty()) {
        continue;
      }

      boolean write = access instanceof CtFieldWrite<?>;
      boolean read = !write || readsWhileWriting(access);
      if (!whitelist.declares(member.get()) || owner.get().kind() != OwnerKind.INVOCABLE) {
        // Same rule as calls: an external field folds up to its declaring type,
        // where a stub can exist; an access outside any invocable is a reference.
        String typeId = ownerType.orElse(UNKNOWN_TYPE_ID);
        if (UNKNOWN_TYPE_ID.equals(typeId)) {
          droppedUnidentifiedTargets++;
        } else if (owner.get().kind() == OwnerKind.INVOCABLE) {
          addAccess(owner.get().id(), typeId, provenance.get(), anchor.get(), read, write);
        } else {
          add(Edge.reference(owner.get().id(), typeId, provenance.get(), anchor.get()));
        }
        continue;
      }
      addAccess(owner.get().id(), member.get(), provenance.get(), anchor.get(), read, write);
    }
  }

  /** {@code x += 1} and {@code x++} read the field they write; {@code x = 1} does not. */
  private static boolean readsWhileWriting(CtFieldAccess<?> access) {
    CtElement parent = parentOf(access);
    if (parent instanceof CtOperatorAssignment<?, ?> assignment) {
      return assignment.getAssigned() == access;
    }
    if (parent instanceof CtUnaryOperator<?> unary) {
      UnaryOperatorKind kind = unary.getKind();
      return kind == UnaryOperatorKind.PREINC
          || kind == UnaryOperatorKind.PREDEC
          || kind == UnaryOperatorKind.POSTINC
          || kind == UnaryOperatorKind.POSTDEC;
    }
    if (parent instanceof CtAssignment<?, ?> assignment) {
      return assignment.getAssigned() != access;
    }
    return true;
  }

  // --------------------------------------------------------------- reference

  /**
   * Annotations are type usages whose type reference carries no position of its
   * own (measured), so they are read from the annotation element instead of the
   * written-reference walk, which would drop them.
   */
  private void emitAnnotations(CtModel model) {
    for (CtAnnotation<?> annotation :
        model.getElements(new TypeFilter<CtAnnotation<?>>(CtAnnotation.class))) {
      Optional<Provenance> provenance = provenanceOf(annotation);
      if (provenance.isEmpty()) {
        continue;
      }
      Optional<String> target =
          safe(() -> EntityIds.forTypeReference(annotation.getAnnotationType()))
              .filter(id -> !UNKNOWN_TYPE_ID.equals(id));
      Optional<SourceAnchor> anchor = anchorOf(annotation);
      Optional<Owner> owner = ownerOf(annotation);
      if (target.isEmpty() || anchor.isEmpty() || owner.isEmpty()) {
        continue;
      }
      add(Edge.reference(owner.get().id(), target.get(), provenance.get(), anchor.get()));
    }
  }

  /**
   * Type usages that no other kind covers: declarations, generic arguments,
   * casts, {@code instanceof}, {@code throws}, type-parameter bounds,
   * {@code X.class}. A reference is claimed only for a type reference that was
   * WRITTEN — one carrying its own source position — because Spoon's tree also
   * holds the inferred type of every expression, which nobody wrote and which
   * would otherwise be reported as a dependency.
   */
  private void emitTypeReferences(CtModel model) {
    for (CtTypeReference<?> reference :
        model.getElements(new TypeFilter<CtTypeReference<?>>(CtTypeReference.class))) {
      if (!isWrittenTypeUse(reference)) {
        continue;
      }
      Optional<Provenance> provenance = provenanceOf(reference);
      if (provenance.isEmpty()) {
        continue;
      }
      Optional<String> target =
          safe(() -> EntityIds.forTypeReference(reference)).filter(id -> !UNKNOWN_TYPE_ID.equals(id));
      Optional<SourceAnchor> anchor = anchorOf(reference);
      Optional<Owner> owner = ownerOf(reference);
      if (target.isEmpty() || anchor.isEmpty() || owner.isEmpty()) {
        continue;
      }
      add(Edge.reference(owner.get().id(), target.get(), provenance.get(), anchor.get()));
    }
  }

  private static boolean isWrittenTypeUse(CtTypeReference<?> reference) {
    if (reference.getPosition() == null || !reference.getPosition().isValidPosition()) {
      return false;
    }
    CtTypeReference<?> element = elementTypeOf(reference);
    if (element == null
        || element.isPrimitive()
        || element instanceof CtTypeParameterReference
        || element instanceof CtWildcardReference) {
      // A primitive is not an entity; a type variable and a wildcard erase to
      // types the source never named.
      return false;
    }
    CtElement parent = parentOf(reference);
    if (parent instanceof CtExecutableReference<?> || parent instanceof CtFieldReference<?>) {
      return false; // the invocation / access edge already states this dependency
    }
    if (parent instanceof CtImport) {
      return false; // the import edge states it, at module granularity
    }
    return !isSupertypeClause(reference, parent);
  }

  /** extends/implements clauses belong to inheritance and interfaceImplementation. */
  private static boolean isSupertypeClause(CtTypeReference<?> reference, CtElement parent) {
    if (!(parent instanceof CtType<?> type)) {
      return false;
    }
    if (reference == type.getSuperclass()) {
      return true;
    }
    for (CtTypeReference<?> implemented : type.getSuperInterfaces()) {
      if (reference == implemented) {
        return true;
      }
    }
    return false;
  }

  private static CtTypeReference<?> elementTypeOf(CtTypeReference<?> reference) {
    CtTypeReference<?> current = reference;
    for (int guard = 0; guard < 64 && current instanceof CtArrayTypeReference<?> array; guard++) {
      current = array.getComponentType();
    }
    return current;
  }

  // ------------------------------------------------------------------- owner

  /**
   * The entity a fact belongs to: the innermost enclosing element the corpus
   * DECLARES. Walking outward rather than naming the innermost element outright
   * is what keeps {@code from} closed over pass 2's output — a method of an
   * anonymous class, say, resolves to the anonymous class when pass 2 emitted
   * only the class. If nothing on the path is whitelisted, the innermost
   * enclosing type is used, so a whitelist that under-reports degrades the
   * granularity of an edge instead of fabricating an entity for it.
   */
  /**
   * The invocable a call or an access belongs to (METAMODEL.md §4: invocation is
   * Invocable → Invocable, access is Invocable → Structural). This is NOT the
   * innermost declared element: {@code List<Order> l = find();} is written
   * inside a local variable, but the call is the method's, not the variable's.
   * Only code written outside every invocable — a field initializer, a static
   * block — has no invocable to belong to, and then the enclosing declaration
   * answers and the fact degrades to a {@code reference}.
   */
  private Optional<Owner> invocableOwnerOf(CtElement element) {
    CtElement current = element;
    for (int guard = 0; current != null && guard < 128; guard++) {
      Optional<Owner> candidate = ownerCandidate(current);
      if (candidate.isPresent()
          && candidate.get().kind() == OwnerKind.INVOCABLE
          && whitelist.declares(candidate.get().id())) {
        return candidate;
      }
      current = parentOf(current);
    }
    return ownerOf(element);
  }

  private Optional<Owner> ownerOf(CtElement element) {
    Owner coarse = null;
    CtElement current = element;
    for (int guard = 0; current != null && guard < 128; guard++) {
      Optional<Owner> candidate = ownerCandidate(current);
      if (candidate.isPresent()) {
        if (whitelist.declares(candidate.get().id())) {
          return candidate;
        }
        if (coarse == null
            && (candidate.get().kind() == OwnerKind.TYPE || candidate.get().kind() == OwnerKind.PACKAGE)) {
          coarse = candidate.get();
        }
      }
      current = parentOf(current);
    }
    return Optional.ofNullable(coarse);
  }

  private Optional<Owner> ownerCandidate(CtElement element) {
    if (element instanceof CtLambda<?> lambda) {
      return lambdaId(lambda).map(id -> new Owner(id, OwnerKind.INVOCABLE));
    }
    if (element instanceof CtMethod<?> method) {
      return typeIdOf(method.getDeclaringType())
          .flatMap(owner -> safe(() -> EntityIds.forMethodIn(owner, method)))
          .map(id -> new Owner(id, OwnerKind.INVOCABLE));
    }
    if (element instanceof CtConstructor<?> constructor) {
      return typeIdOf(constructor.getDeclaringType())
          .flatMap(owner -> safe(() -> EntityIds.forConstructorIn(owner, constructor)))
          .map(id -> new Owner(id, OwnerKind.INVOCABLE));
    }
    if (element instanceof CtParameter<?> parameter) {
      return executableIdOf(parentOf(parameter))
          .flatMap(owner -> safe(() -> EntityIds.forParameterOf(owner, parameter.getSimpleName())))
          .map(id -> new Owner(id, OwnerKind.MEMBER));
    }
    if (element instanceof CtLocalVariable<?> local) {
      return executableIdOf(local.getParent(CtExecutable.class))
          .flatMap(
              owner ->
                  safe(
                      () ->
                          EntityIds.forLocalVariableOf(
                              owner, local.getSimpleName(), local.getPosition().getLine())))
          .map(id -> new Owner(id, OwnerKind.MEMBER));
    }
    if (element instanceof CtField<?> field) {
      return typeIdOf(field.getDeclaringType())
          .flatMap(owner -> safe(() -> EntityIds.forFieldIn(owner, field)))
          .map(id -> new Owner(id, OwnerKind.MEMBER));
    }
    if (element instanceof CtType<?> type) {
      return typeIdOf(type).map(id -> new Owner(id, OwnerKind.TYPE));
    }
    if (element instanceof CtPackage pkg) {
      return safe(() -> EntityIds.forPackage(pkg)).map(id -> new Owner(id, OwnerKind.PACKAGE));
    }
    // Static and instance initializer blocks have no entity kind in the Java
    // profile: the walk continues to the type that owns them.
    return Optional.empty();
  }

  private Optional<String> executableIdOf(CtElement element) {
    if (element == null) {
      return Optional.empty();
    }
    return ownerCandidate(element).filter(o -> o.kind() == OwnerKind.INVOCABLE).map(Owner::id);
  }

  /** Anonymous classes are identified by (file, line); named ones by their name. */
  private Optional<String> typeIdOf(CtType<?> type) {
    if (type == null || type instanceof CtTypeParameter) {
      return Optional.empty();
    }
    if (isAnonymous(type)) {
      String file = anchors.relativeFile(type);
      return file == null
          ? Optional.empty()
          : safe(() -> EntityIds.forAnonymousClass((CtClass<?>) type, file));
    }
    return safe(() -> EntityIds.forType(type));
  }

  private Optional<String> lambdaId(CtLambda<?> lambda) {
    String file = anchors.relativeFile(lambda);
    return file == null ? Optional.empty() : safe(() -> EntityIds.forLambda(lambda, file));
  }

  // ------------------------------------------------------------- provenance

  /**
   * {@code declared} for anything written in the source, {@code generated} for a
   * visible Lombok expansion, empty for the rest of what Spoon materializes.
   *
   * <p>Spoon marks as implicit both what a generator produced and what the
   * language implies (an inserted {@code super()}, a {@code this} target). Only
   * the first is a member the corpus really has, and the Java profile says so:
   * Lombok expansions are {@code generated} when visible and simply absent when
   * not. The discriminator is a {@code lombok.*} annotation on the enclosing
   * type; without it, an implicit element is a Spoon artifact and states nothing.
   */
  private static Optional<Provenance> provenanceOf(CtElement element) {
    boolean implicit = false;
    CtElement current = element;
    for (int guard = 0; current != null && guard < 128; guard++) {
      if (current.isImplicit()) {
        implicit = true;
      }
      if (current instanceof CtType<?> type && !(current instanceof CtTypeParameter)) {
        if (!implicit) {
          return Optional.of(Provenance.DECLARED);
        }
        return isLombokAnnotated(type) ? Optional.of(Provenance.GENERATED) : Optional.empty();
      }
      current = parentOf(current);
    }
    return implicit ? Optional.empty() : Optional.of(Provenance.DECLARED);
  }

  private static boolean isLombokAnnotated(CtType<?> type) {
    for (CtAnnotation<?> annotation : type.getAnnotations()) {
      CtTypeReference<?> annotationType = annotation.getAnnotationType();
      String name = annotationType == null ? null : annotationType.getQualifiedName();
      if (name != null && name.startsWith(LOMBOK_PACKAGE_PREFIX)) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- plumbing

  private void reset() {
    edges.clear();
    accesses.clear();
    directSubtypes.clear();
    transitiveSubtypes.clear();
    droppedSelfReferences = 0;
    droppedUnidentifiedTargets = 0;
    droppedUnanchoredFacts = 0;
  }

  /**
   * Every type the corpus declares — nested, local and anonymous included.
   * {@code getAllTypes()} returns only top-level ones (measured), and the
   * element walk additionally turns up {@link CtTypeParameter}s, which are not
   * types the corpus declares.
   */
  private List<DeclaredType> corpusTypes(CtModel model) {
    List<DeclaredType> declared = new ArrayList<>();
    for (CtType<?> type : model.getElements(new TypeFilter<CtType<?>>(CtType.class))) {
      typeIdOf(type).ifPresent(id -> declared.add(new DeclaredType(id, type)));
    }
    declared.sort(Comparator.comparing(DeclaredType::id));
    return declared;
  }

  private void indexSubtypes(List<DeclaredType> types) {
    for (DeclaredType declared : types) {
      CtTypeReference<?> superclass = declared.type().getSuperclass();
      if (superclass != null) {
        supertypeId(superclass)
            .ifPresent(id -> directSubtypes.computeIfAbsent(id, k -> new TreeSet<>()).add(declared.id()));
      }
      for (CtTypeReference<?> implemented : declared.type().getSuperInterfaces()) {
        if (implemented != null) {
          supertypeId(implemented)
              .ifPresent(id -> directSubtypes.computeIfAbsent(id, k -> new TreeSet<>()).add(declared.id()));
        }
      }
    }
  }

  /** Transitive corpus subtypes of a type id, memoized; sorted, never null. */
  private Set<String> subtypesOf(String typeId) {
    Set<String> memoized = transitiveSubtypes.get(typeId);
    if (memoized != null) {
      return memoized;
    }
    Set<String> result = new TreeSet<>();
    Set<String> visited = new TreeSet<>();
    List<String> queue = new ArrayList<>(directSubtypes.getOrDefault(typeId, Set.of()));
    while (!queue.isEmpty()) {
      String current = queue.remove(queue.size() - 1);
      if (!visited.add(current)) {
        continue;
      }
      result.add(current);
      queue.addAll(directSubtypes.getOrDefault(current, Set.of()));
    }
    Set<String> immutable = Set.copyOf(result);
    transitiveSubtypes.put(typeId, immutable);
    return immutable;
  }

  private Optional<Target> targetOf(CtExecutableReference<?> executable) {
    Optional<String> member = safe(() -> EntityIds.forExecutableReference(executable));
    if (member.isEmpty()) {
      return Optional.empty();
    }
    CtTypeReference<?> declaring = executable.getDeclaringType();
    String type =
        declaring == null
            ? UNKNOWN_TYPE_ID
            : safe(() -> EntityIds.forTypeReference(declaring)).orElse(UNKNOWN_TYPE_ID);
    return Optional.of(new Target(member.get(), type));
  }

  private Optional<SourceAnchor> anchorOf(CtElement element) {
    Optional<SourceAnchor> anchor = anchors.orEnclosing(element);
    if (anchor.isEmpty()) {
      droppedUnanchoredFacts++;
    }
    return anchor;
  }

  private void add(Edge edge) {
    if (edge.selfReference()) {
      droppedSelfReferences++;
      return;
    }
    edges.add(edge);
  }

  /**
   * Accesses are merged per (from, to, provenance, anchor): {@code x = x + 1}
   * writes and reads the same field on the same line, and the metamodel says
   * that with two booleans on one edge rather than with two edges.
   */
  private void addAccess(
      String from, String to, Provenance provenance, SourceAnchor anchor, boolean read, boolean write) {
    if (from.equals(to)) {
      droppedSelfReferences++;
      return;
    }
    boolean[] flags = accesses.computeIfAbsent(new AccessKey(from, to, provenance, anchor), key -> new boolean[2]);
    flags[0] |= read;
    flags[1] |= write;
  }

  private List<Edge> assemble() {
    List<Edge> all = new ArrayList<>(edges.size() + accesses.size());
    all.addAll(edges);
    for (Map.Entry<AccessKey, boolean[]> entry : accesses.entrySet()) {
      AccessKey key = entry.getKey();
      boolean write = entry.getValue()[1];
      // An access is a read unless it is exclusively a write; Edge rejects an
      // access that claims to be neither.
      boolean read = entry.getValue()[0] || !write;
      all.add(Edge.access(key.from(), key.to(), key.provenance(), key.anchor(), read, write));
    }
    all.sort(TOTAL_ORDER);
    return List.copyOf(all);
  }

  private static boolean isAnonymous(CtType<?> type) {
    return type instanceof CtClass<?> clazz && clazz.isAnonymous();
  }

  private static CtCompilationUnit compilationUnitOf(CtType<?> type) {
    if (type.getPosition() == null || !type.getPosition().isValidPosition()) {
      return null;
    }
    return type.getPosition().getCompilationUnit();
  }

  private static CtElement parentOf(CtElement element) {
    try {
      return element.isParentInitialized() ? element.getParent() : null;
    } catch (RuntimeException e) {
      return null;
    }
  }

  private static CtExecutable<?> safeDeclaration(CtExecutableReference<?> executable) {
    try {
      return executable.getExecutableDeclaration();
    } catch (RuntimeException e) {
      return null;
    }
  }

  /**
   * {@link EntityIds} rejects what it cannot identify — an element with no
   * position, a nameless type — by throwing. Spoon hands us exactly such
   * elements in noClasspath mode, and a fact we cannot name is a fact we do not
   * state.
   */
  private static Optional<String> safe(Supplier<String> supplier) {
    try {
      String value = supplier.get();
      return value == null || value.isBlank() ? Optional.empty() : Optional.of(value);
    } catch (RuntimeException e) {
      return Optional.empty();
    }
  }

  private enum OwnerKind {
    INVOCABLE,
    TYPE,
    PACKAGE,
    MEMBER
  }

  private record Owner(String id, OwnerKind kind) {}

  private record Target(String memberId, String typeId) {}

  private record ImportTarget(String id, Provenance provenance) {}

  private record DeclaredType(String id, CtType<?> type) {}

  private record AccessKey(String from, String to, Provenance provenance, SourceAnchor anchor) {}
}
