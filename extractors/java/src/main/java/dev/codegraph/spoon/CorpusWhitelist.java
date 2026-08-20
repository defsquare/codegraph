package dev.codegraph.spoon;

import java.nio.file.Path;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Supplier;
import spoon.reflect.CtModel;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.cu.SourcePosition;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeParameter;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.visitor.filter.TypeFilter;

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
 * <p>Resolvability is not membership either: {@code java.lang.String} resolves
 * ({@code getTypeDeclaration() != null}) because it is on the JVM's classpath,
 * yet no corpus file declares it, so it is a stub like any other external type.
 *
 * <p>What counts as declared, and why:
 * <ul>
 *   <li><b>Every type</b>, reached through {@code getElements(CtType)} rather
 *       than {@code getAllTypes()} — measured: a corpus declaring
 *       {@code OrderService.Inner} yields exactly ONE type from
 *       {@code getAllTypes()}. That walk also reaches local classes (Spoon names
 *       them {@code 1Local}) and anonymous ones, which no amount of recursion
 *       through {@code getNestedTypes()} would find. {@link CtTypeParameter} is a
 *       {@link CtType} but a {@code <T>} is not an entity, so it is excluded.
 *   <li><b>Members</b>: methods, constructors, fields, parameters, locals and
 *       lambdas — they are declared by the corpus and are legitimate edge
 *       endpoints. Parameter/local ids are built from their <i>innermost</i>
 *       enclosing executable, which may be a lambda or a method of an anonymous
 *       class; those owners have no name-derived id, hence the {@code *Of}
 *       primitives in {@link EntityIds}.
 *   <li><b>Packages that a corpus type is written in</b> — and only those.
 *       Spoon's package tree also holds the empty ancestors it had to create
 *       ({@code com}, {@code com.acme} for a lone {@code com.acme.order} type);
 *       no compilation unit declares them, so they are not corpus entities.
 * </ul>
 *
 * <p>Implicit members count as declared: Spoon materializes a default
 * constructor for every class that omits one, and {@code new Inner()} targets
 * corpus code — answering "external" there would be exactly the lie this class
 * prevents. Such a constructor has no source position of its own, so the entity
 * pass must anchor it to its declaring type.
 *
 * <p>Ids come from {@link EntityIds} and nowhere else. An element whose id
 * cannot be built (no valid source position for a lambda, no enclosing named
 * type) is skipped rather than guessed: a whitelist entry that disagrees with
 * the id the entity pass emits is worse than a missing one.
 */
public final class CorpusWhitelist {

  private final Set<String> declaredIds;

  private CorpusWhitelist(Collection<String> declaredIds) {
    // Sorted iteration AND O(1) membership: a LinkedHashSet filled from a
    // TreeSet. Set.copyOf would be wrong here — its iteration order is salted
    // per JVM run, so anything derived from ids() would stop being
    // byte-identical between runs.
    Set<String> sorted = new TreeSet<>();
    for (String id : declaredIds) {
      if (id == null || id.isBlank()) {
        throw new IllegalArgumentException("a declared id must be non-blank");
      }
      sorted.add(id);
    }
    this.declaredIds = Collections.unmodifiableSet(new LinkedHashSet<>(sorted));
  }

  /**
   * PASS 1, as {@code Main} calls it. Lambda and anonymous-class ids embed the
   * root-relative file they were written in, so this overload has to invent the
   * root: it strips each compilation unit's package directories, then takes the
   * deepest common ancestor. That reconstructs {@code Main.commonRoot} exactly
   * when {@code --src} points at a source root, and can differ otherwise —
   * prefer {@link #build(CtModel, Anchors)} and hand it the same {@link Anchors}
   * every other pass uses.
   *
   * @return an immutable whitelist; {@link #ids()} is the immutable
   *     {@code Set<String>} of declared ids
   */
  public static CorpusWhitelist build(CtModel model) {
    return build(model, new Anchors(inferRoot(model)));
  }

  /** PASS 1 with the pipeline's own {@link Anchors} — the form to prefer. */
  public static CorpusWhitelist build(CtModel model, Anchors anchors) {
    return build(model, anchors, Progress.none());
  }

  /** PASS 1, reporting its progress; the type scan is the part worth a bar. */
  public static CorpusWhitelist build(CtModel model, Anchors anchors, Progress progress) {
    Objects.requireNonNull(model, "model");
    Objects.requireNonNull(anchors, "anchors");
    Objects.requireNonNull(progress, "progress");

    Set<String> ids = new TreeSet<>();

    // Only packages a corpus type is actually written in; getAllTypes() returns
    // the top-level types, which is exactly the set that carries a package.
    for (CtType<?> topLevel : model.getAllTypes()) {
      addSafely(ids, () -> EntityIds.forPackage(topLevel.getPackage()));
    }

    List<CtType<?>> types = model.getElements(new TypeFilter<>(CtType.class));
    Progress.Phase phase = progress.phase("whitelist", types.size(), "types");
    for (CtType<?> type : types) {
      phase.step();
      if (type instanceof CtTypeParameter) {
        continue;
      }
      // WRITTEN HERE, not merely reachable. In noClasspath mode Spoon
      // materializes shadow CtTypes for types it could not load — measured on
      // apache/fineract: `jakarta.ws.rs.core.MediaType`, `java.math.BigDecimal`
      // and hundreds more appear in the model with NO source position. They are
      // external by definition, and the entity pass already refuses them for
      // exactly this reason (a type with no evidence is not representable).
      // Asking the same question here is what keeps the two passes agreeing —
      // the property this class's own contract calls for. Without it the
      // whitelist claims a type as corpus-declared, the stub pass then refuses
      // to degrade it ("declared but never emitted"), and every reference to it
      // dangles.
      if (anchors.orEnclosing(type).isEmpty()) {
        continue;
      }
      String typeId = typeIdOf(type, anchors);
      if (typeId == null) {
        continue;
      }
      ids.add(typeId);
      for (CtField<?> field : type.getFields()) {
        addSafely(ids, () -> EntityIds.forFieldIn(typeId, field));
      }
      for (CtMethod<?> method : type.getMethods()) {
        addSafely(ids, () -> EntityIds.forMethodIn(typeId, method));
      }
      if (type instanceof CtClass<?> declaringClass) {
        for (CtConstructor<?> constructor : declaringClass.getConstructors()) {
          addSafely(ids, () -> EntityIds.forConstructorIn(typeId, constructor));
        }
      }
    }

    for (CtLambda<?> lambda : model.getElements(new TypeFilter<>(CtLambda.class))) {
      String id = lambdaId(lambda, anchors);
      if (id != null) {
        ids.add(id);
      }
    }

    for (CtParameter<?> parameter : model.getElements(new TypeFilter<>(CtParameter.class))) {
      String owner = executableId(parameter.getParent(CtExecutable.class), anchors);
      if (owner != null) {
        addSafely(ids, () -> EntityIds.forParameterOf(owner, parameter.getSimpleName()));
      }
    }

    for (CtLocalVariable<?> local : model.getElements(new TypeFilter<>(CtLocalVariable.class))) {
      // A local in a static/instance initializer has no owning entity in the
      // Java profile (an initializer block is not a `method`), so it is skipped.
      String owner = executableId(local.getParent(CtExecutable.class), anchors);
      int line = startLineOf(local);
      if (owner != null && line > 0) {
        addSafely(ids, () -> EntityIds.forLocalVariableOf(owner, local.getSimpleName(), line));
      }
    }

    phase.close();
    return of(ids);
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
    return id != null && declaredIds.contains(id);
  }

  /** Alias of {@link #declares(String)} — the same single membership question. */
  public boolean contains(String id) {
    return declares(id);
  }

  /**
   * Membership for a referenced type — the form the entity and edge passes hold.
   * A reference Spoon could resolve may still be external ({@code java.lang.String}
   * resolves and is not corpus code), and a reference it could not resolve may
   * still be a fabricated FQN inside a corpus package; only the id decides.
   */
  public boolean declaresType(CtTypeReference<?> reference) {
    return reference != null && declares(EntityIds.forTypeReference(reference));
  }

  /** Membership for a declared type; anonymous classes have no name-derived id. */
  public boolean declaresType(CtType<?> type) {
    if (type == null || type instanceof CtTypeParameter) {
      return false;
    }
    try {
      return declares(EntityIds.forType(type));
    } catch (IllegalArgumentException anonymousOrNameless) {
      return false;
    }
  }

  public int size() {
    return declaredIds.size();
  }

  // ---------------------------------------------------------------- internals

  private static String typeIdOf(CtType<?> type, Anchors anchors) {
    if (type instanceof CtClass<?> maybeAnonymous && maybeAnonymous.isAnonymous()) {
      String file = anchors.relativeFile(type);
      return file == null ? null : idOrNull(() -> EntityIds.forAnonymousClass(maybeAnonymous, file));
    }
    return idOrNull(() -> EntityIds.forType(type));
  }

  private static String lambdaId(CtLambda<?> lambda, Anchors anchors) {
    String file = anchors.relativeFile(lambda);
    return file == null ? null : idOrNull(() -> EntityIds.forLambda(lambda, file));
  }

  /** Null for anything the Java profile has no entity kind for (initializer blocks). */
  private static String executableId(CtExecutable<?> executable, Anchors anchors) {
    if (executable instanceof CtLambda<?> lambda) {
      return lambdaId(lambda, anchors);
    }
    if (executable instanceof CtMethod<?> method) {
      String owner = typeIdOf(method.getDeclaringType(), anchors);
      return owner == null ? null : idOrNull(() -> EntityIds.forMethodIn(owner, method));
    }
    if (executable instanceof CtConstructor<?> constructor) {
      String owner = typeIdOf(constructor.getDeclaringType(), anchors);
      return owner == null ? null : idOrNull(() -> EntityIds.forConstructorIn(owner, constructor));
    }
    return null;
  }

  private static int startLineOf(CtLocalVariable<?> local) {
    SourcePosition position = local.getPosition();
    return (position != null && position.isValidPosition()) ? position.getLine() : -1;
  }

  /**
   * An id that cannot be built names nothing the corpus declares — omitting it
   * degrades that construct to a stub, which is honest; inventing one would
   * create a whitelist entry no entity ever matches.
   */
  private static void addSafely(Set<String> ids, Supplier<String> idBuilder) {
    String id = idOrNull(idBuilder);
    if (id != null) {
      ids.add(id);
    }
  }

  private static String idOrNull(Supplier<String> idBuilder) {
    try {
      String id = idBuilder.get();
      return (id == null || id.isBlank()) ? null : id;
    } catch (IllegalArgumentException notIdentifiable) {
      return null;
    }
  }

  /**
   * Best-effort source root for {@link #build(CtModel)}: a file at
   * {@code …/src/main/java/com/acme/order/X.java} declaring package
   * {@code com.acme.order} has source root {@code …/src/main/java}. The deepest
   * common ancestor of those roots is the model root.
   */
  private static Path inferRoot(CtModel model) {
    Path common = null;
    for (CtType<?> type : model.getAllTypes()) {
      SourcePosition position = type.getPosition();
      if (position == null || !position.isValidPosition() || position.getFile() == null) {
        continue;
      }
      Path directory = position.getFile().toPath().toAbsolutePath().normalize().getParent();
      String packageName =
          type.getPackage() == null || type.getPackage().isUnnamedPackage()
              ? ""
              : type.getPackage().getQualifiedName();
      if (!packageName.isEmpty()) {
        for (int i = 0; i < packageName.split("\\.").length && directory != null; i++) {
          directory = directory.getParent();
        }
      }
      if (directory == null) {
        continue;
      }
      common = (common == null) ? directory : deepestCommonAncestor(common, directory);
    }
    return common == null ? Path.of("").toAbsolutePath() : common;
  }

  private static Path deepestCommonAncestor(Path left, Path right) {
    Path candidate = left;
    while (candidate != null && !right.startsWith(candidate)) {
      candidate = candidate.getParent();
    }
    return candidate == null ? Path.of("/") : candidate;
  }
}
