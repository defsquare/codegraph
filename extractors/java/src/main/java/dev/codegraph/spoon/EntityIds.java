package dev.codegraph.spoon;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtPackage;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.reference.CtArrayTypeReference;
import spoon.reflect.reference.CtExecutableReference;
import spoon.reflect.reference.CtFieldReference;
import spoon.reflect.reference.CtPackageReference;
import spoon.reflect.reference.CtTypeParameterReference;
import spoon.reflect.reference.CtTypeReference;

/**
 * THE Java id scheme. Every id in the model comes from here; a bug in this file
 * corrupts every id and every edge endpoint.
 *
 * <pre>
 *   package        java:&lt;packageFqn&gt;                              java:com.acme.order
 *   (default pkg)  java:&lt;unnamed&gt;
 *   type           java:&lt;packageFqn&gt;/&lt;TypeName&gt;                    java:com.acme.order/OrderService
 *   nested type    java:&lt;packageFqn&gt;/&lt;Outer&gt;.&lt;Inner&gt;               java:com.acme.order/OrderService.Inner
 *   method         java:&lt;pkg&gt;/&lt;Type&gt;.&lt;name&gt;(&lt;paramTypeFqn,...&gt;)     java:com.acme.order/OrderService.bill(com.acme.order.Order)
 *   constructor    java:&lt;pkg&gt;/&lt;Type&gt;.&lt;init&gt;(&lt;paramTypeFqn,...&gt;)
 *   lambda / anon  java:&lt;pkg&gt;/&lt;Type&gt;#&lt;file&gt;:&lt;startLine&gt;
 *   field          java:&lt;pkg&gt;/&lt;Type&gt;.&lt;fieldName&gt;
 *   parameter      java:&lt;pkg&gt;/&lt;Type&gt;.&lt;methodSig&gt;#param:&lt;name&gt;
 *   local variable java:&lt;pkg&gt;/&lt;Type&gt;.&lt;methodSig&gt;#local:&lt;name&gt;:&lt;startLine&gt;
 *   stub type      java:&lt;packageFqn&gt;/&lt;TypeName&gt;   — same shape as any type
 * </pre>
 *
 * <p><b>A stub's id has the same shape as a declared type's id on purpose.</b>
 * Corpus membership is decided ONLY by {@link CorpusWhitelist} — the set of ids
 * actually declared in pass 1 — never by the id's shape and never by a package
 * prefix. Spoon in noClasspath mode invents fully-qualified names by assuming
 * the enclosing package (measured: it reported {@code com.acme.order.Order} and
 * {@code com.acme.order.Invoice} for types that exist nowhere), so a prefix
 * filter would launder those fabrications into facts.
 *
 * <p><b>Parameter types in ids are erased FULLY-QUALIFIED names.</b>
 * METAMODEL.md §10's illustrative example writes {@code bill(Order)}, but simple
 * names genuinely collide: {@code f(java.util.List)} and {@code f(java.awt.List)}
 * are legal overloads that would both render as {@code f(List)} and merge into
 * one entity. Ids must be unique per model, so the FQN form wins. The
 * {@code signature} attribute contributed by TInvocable uses the same rendering.
 *
 * <p>Erasure rules, applied everywhere a type appears inside an id:
 * generic arguments are dropped ({@code List<String>} → {@code java.util.List}),
 * arrays render as {@code java.lang.String[]}, varargs render as the array form,
 * a type variable erases to its first bound ({@code <T extends Number>} →
 * {@code java.lang.Number}, unbounded → {@code java.lang.Object}), nested types
 * render with a dot ({@code Outer.Inner}, never Spoon's {@code Outer$Inner}).
 *
 * <p>Ids are opaque to the analyzer, which only compares them. The extractor
 * owns the scheme, so the few parsing helpers here ({@link #typeSimpleName},
 * {@link #packageIdOfTypeId}) are legitimate — anywhere else, parsing an id is a
 * bug.
 */
public final class EntityIds {

  /** Frozen (PLAN.md §4.4): renaming it invalidates every id ever emitted. */
  public static final String LANG = "java";

  public static final String PREFIX = LANG + ":";

  /** Module part for the default (unnamed) package. */
  public static final String UNNAMED_PACKAGE = "<unnamed>";

  /** Spoon's and the JVM's name for a constructor; also the id's member name. */
  public static final String CONSTRUCTOR_NAME = "<init>";

  private static final String UNKNOWN_TYPE = "<unknown>";

  private EntityIds() {}

  // ---------------------------------------------------------------- packages

  public static String forPackage(CtPackage pkg) {
    if (pkg == null) {
      return forPackageName(null);
    }
    return forPackageName(pkg.isUnnamedPackage() ? "" : pkg.getQualifiedName());
  }

  /** {@code ""} or {@code null} is the default package. */
  public static String forPackageName(String packageQualifiedName) {
    String fqn =
        (packageQualifiedName == null || packageQualifiedName.isBlank())
            ? UNNAMED_PACKAGE
            : packageQualifiedName;
    return PREFIX + fqn;
  }

  /** The package id owning a type id: {@code java:com.acme/Outer.Inner} → {@code java:com.acme}. */
  public static String packageIdOfTypeId(String typeId) {
    String body = stripPrefix(typeId);
    int slash = body.indexOf('/');
    return PREFIX + (slash < 0 ? UNNAMED_PACKAGE : body.substring(0, slash));
  }

  // ------------------------------------------------------------------- types

  /**
   * Id of a declared type, nested types included. Anonymous classes are
   * rejected: they have no name to be identified by, so they take the
   * {@code #file:line} form via {@link #forAnonymousClass}.
   */
  public static String forType(CtType<?> type) {
    if (type == null) {
      throw new IllegalArgumentException("cannot build an id for a null type");
    }
    if (type instanceof CtClass<?> c && c.isAnonymous()) {
      throw new IllegalArgumentException(
          "anonymous classes have no name — use forAnonymousClass(type, relativeFile)");
    }
    Deque<String> path = new ArrayDeque<>();
    CtType<?> current = type;
    while (current != null) {
      path.push(normalizeName(current.getSimpleName()));
      current = current.getDeclaringType();
    }
    CtType<?> top = type.getTopLevelType();
    CtPackage pkg = top == null ? null : top.getPackage();
    String pkgFqn = (pkg == null || pkg.isUnnamedPackage()) ? "" : pkg.getQualifiedName();
    return typeId(pkgFqn, String.join(".", path));
  }

  /**
   * Id of a <i>referenced</i> type — the only form available for types Spoon
   * could not resolve, which is the common case in noClasspath mode. Arrays are
   * unwrapped to their component type (an array is not an entity, the element
   * type is) and type variables to their bound.
   */
  public static String forTypeReference(CtTypeReference<?> reference) {
    if (reference == null) {
      return typeId("", UNKNOWN_TYPE);
    }
    CtTypeReference<?> ref = elementTypeOf(reference);
    if (ref == null) {
      // An unbounded type variable erases to Object (JLS 4.6).
      return typeId("java.lang", "Object");
    }
    String qualified = normalizeName(ref.getQualifiedName());
    if (qualified.isEmpty()) {
      qualified = normalizeName(ref.getSimpleName());
    }
    if (qualified.isEmpty()) {
      return typeId("", UNKNOWN_TYPE);
    }

    // Prefer the package Spoon attached to the reference; fall back to splitting
    // the qualified name at the last dot before the outermost type name.
    String pkgFqn = null;
    CtPackageReference pkgRef = outermost(ref).getPackage();
    if (pkgRef != null) {
      String candidate = pkgRef.getQualifiedName();
      if (candidate != null && !candidate.isBlank() && qualified.startsWith(candidate + ".")) {
        pkgFqn = candidate;
      } else if (candidate != null && candidate.isBlank()) {
        pkgFqn = "";
      }
    }
    if (pkgFqn == null) {
      int lastDotOfHead = headOf(qualified).lastIndexOf('.');
      pkgFqn = lastDotOfHead < 0 ? "" : qualified.substring(0, lastDotOfHead);
    }
    String typePath = pkgFqn.isEmpty() ? qualified : qualified.substring(pkgFqn.length() + 1);
    return typeId(pkgFqn, typePath);
  }

  /** {@code java:<pkg>/<Type>#<file>:<startLine>} — lambdas and anonymous classes. */
  public static String forAnonymous(String enclosingTypeId, String relativeFile, int startLine) {
    requireText(enclosingTypeId, "enclosing type id");
    requireText(relativeFile, "relative file");
    if (startLine < 1) {
      throw new IllegalArgumentException("anonymous entities need a 1-based line, got " + startLine);
    }
    return enclosingTypeId + "#" + relativeFile + ":" + startLine;
  }

  public static String forLambda(CtLambda<?> lambda, String relativeFile) {
    return forAnonymous(forType(enclosingNamedType(lambda)), relativeFile, startLineOf(lambda));
  }

  public static String forAnonymousClass(CtClass<?> anonymous, String relativeFile) {
    return forAnonymous(forType(enclosingNamedType(anonymous)), relativeFile, startLineOf(anonymous));
  }

  // ----------------------------------------------------------------- members

  public static String forMethod(CtMethod<?> method) {
    return forMethodIn(forType(method.getDeclaringType()), method);
  }

  /** For methods whose owner has no name-based id (a method inside an anonymous class). */
  public static String forMethodIn(String ownerTypeId, CtMethod<?> method) {
    return ownerTypeId + "." + signatureOf(method);
  }

  public static String forConstructor(CtConstructor<?> constructor) {
    return forConstructorIn(forType(constructor.getDeclaringType()), constructor);
  }

  public static String forConstructorIn(String ownerTypeId, CtConstructor<?> constructor) {
    return ownerTypeId + "." + signatureOf(constructor);
  }

  /**
   * Id of an invoked executable, resolved or not. Constructors keep the
   * {@code <init>} member name, matching {@link #forConstructor}.
   */
  public static String forExecutableReference(CtExecutableReference<?> reference) {
    CtTypeReference<?> owner = reference.getDeclaringType();
    String ownerId = owner == null ? typeId("", UNKNOWN_TYPE) : forTypeReference(owner);
    return forExecutableReferenceIn(ownerId, reference);
  }

  /**
   * Same id, with the owner supplied. The caller knows things a reference does
   * not: an anonymous class is identified by {@code #file:line}, not by Spoon's
   * {@code Outer$N} name, so its members must be named under that id or they
   * miss the entity pass 2 declared.
   */
  public static String forExecutableReferenceIn(
      String ownerTypeId, CtExecutableReference<?> reference) {
    requireText(ownerTypeId, "owner type id");
    String name =
        reference.isConstructor() ? CONSTRUCTOR_NAME : normalizeName(reference.getSimpleName());
    return ownerTypeId + "." + name + renderParameterTypes(reference.getParameters());
  }

  public static String forField(CtField<?> field) {
    return forFieldIn(forType(field.getDeclaringType()), field);
  }

  public static String forFieldIn(String ownerTypeId, CtField<?> field) {
    return ownerTypeId + "." + field.getSimpleName();
  }

  /** Id of an accessed field, resolved or not. */
  public static String forFieldReference(CtFieldReference<?> reference) {
    CtTypeReference<?> owner = reference.getDeclaringType();
    String ownerId = owner == null ? typeId("", UNKNOWN_TYPE) : forTypeReference(owner);
    return forFieldReferenceIn(ownerId, reference);
  }

  /** Same id, with the owner supplied — see {@link #forExecutableReferenceIn}. */
  public static String forFieldReferenceIn(String ownerTypeId, CtFieldReference<?> reference) {
    requireText(ownerTypeId, "owner type id");
    return ownerTypeId + "." + reference.getSimpleName();
  }

  // ------------------------------------------------- parameters and locals

  /** {@code <executableId>#param:<name>} — works for methods, constructors and lambdas alike. */
  public static String forParameterOf(String ownerExecutableId, String parameterName) {
    requireText(ownerExecutableId, "owner executable id");
    requireText(parameterName, "parameter name");
    return ownerExecutableId + "#param:" + parameterName;
  }

  public static String forParameter(CtParameter<?> parameter) {
    return forParameterOf(forExecutable(parameter.getParent()), parameter.getSimpleName());
  }

  /** The start line disambiguates two locals of the same name in sibling blocks. */
  public static String forLocalVariableOf(String ownerExecutableId, String name, int startLine) {
    requireText(ownerExecutableId, "owner executable id");
    requireText(name, "local variable name");
    if (startLine < 1) {
      throw new IllegalArgumentException("local variable ids need a 1-based line, got " + startLine);
    }
    return ownerExecutableId + "#local:" + name + ":" + startLine;
  }

  public static String forLocalVariable(CtLocalVariable<?> local) {
    CtExecutable<?> owner = local.getParent(CtExecutable.class);
    return forLocalVariableOf(forExecutable(owner), local.getSimpleName(), startLineOf(local));
  }

  // -------------------------------------------------------------- signatures

  /** TInvocable's {@code signature}: {@code bill(com.acme.order.Order)}. */
  public static String signatureOf(CtMethod<?> method) {
    return method.getSimpleName() + renderParameters(method.getParameters());
  }

  /** A constructor has no name, so its signature uses the JVM's {@code <init>}. */
  public static String signatureOf(CtConstructor<?> constructor) {
    return CONSTRUCTOR_NAME + renderParameters(constructor.getParameters());
  }

  /** A lambda has neither name nor own signature name: parameter list only. */
  public static String signatureOf(CtLambda<?> lambda) {
    return renderParameters(lambda.getParameters());
  }

  /**
   * The erased, fully-qualified rendering of a type as it appears inside an id
   * or a signature. Arrays keep their {@code []} suffix here (unlike
   * {@link #forTypeReference}, which unwraps them, because an array is not an
   * entity but IS a distinct parameter type for overload resolution).
   */
  public static String erasedTypeName(CtTypeReference<?> reference) {
    if (reference == null) {
      return UNKNOWN_TYPE;
    }
    if (reference instanceof CtArrayTypeReference<?> array) {
      return erasedTypeName(array.getComponentType()) + "[]";
    }
    if (reference instanceof CtTypeParameterReference typeParameter) {
      CtTypeReference<?> bound = typeParameter.getBoundingType();
      return bound == null ? "java.lang.Object" : erasedTypeName(bound);
    }
    String qualified = normalizeName(reference.getQualifiedName());
    if (qualified.isEmpty()) {
      qualified = normalizeName(reference.getSimpleName());
    }
    return qualified.isEmpty() ? UNKNOWN_TYPE : qualified;
  }

  // ------------------------------------------------- id-reading (extractor-only)

  /**
   * Simple name of a type id — {@code java:com.acme/Outer.Inner} → {@code Inner}.
   * Used to give a synthesized stub its TNamed {@code name}; the extractor owns
   * the scheme, so it may read its own ids. The analyzer must not.
   */
  public static String typeSimpleName(String typeId) {
    String qualified = typeQualifiedName(typeId);
    int lastDot = qualified.lastIndexOf('.');
    return lastDot < 0 ? qualified : qualified.substring(lastDot + 1);
  }

  /** {@code java:com.acme/Outer.Inner} → {@code Outer.Inner} (the type path, package excluded). */
  public static String typeQualifiedName(String typeId) {
    String body = stripPrefix(typeId);
    int slash = body.indexOf('/');
    return slash < 0 ? body : body.substring(slash + 1);
  }

  // ------------------------------------------------------------------ internals

  private static String typeId(String packageFqn, String typePath) {
    String pkg = (packageFqn == null || packageFqn.isBlank()) ? UNNAMED_PACKAGE : packageFqn;
    String path = (typePath == null || typePath.isBlank()) ? UNKNOWN_TYPE : typePath;
    return PREFIX + pkg + "/" + path;
  }

  private static String forExecutable(Object owner) {
    if (owner instanceof CtMethod<?> method) {
      return forMethod(method);
    }
    if (owner instanceof CtConstructor<?> constructor) {
      return forConstructor(constructor);
    }
    throw new IllegalArgumentException(
        "owner is not a named executable ("
            + (owner == null ? "null" : owner.getClass().getSimpleName())
            + "); build the owner id first and use forParameterOf/forLocalVariableOf");
  }

  /** Renders a declared parameter list, honouring varargs as the array form. */
  private static String renderParameters(List<? extends CtParameter<?>> parameters) {
    List<String> rendered = new ArrayList<>(parameters.size());
    for (CtParameter<?> parameter : parameters) {
      String name = erasedTypeName(parameter.getType());
      // `String... args` is `String[]` at the JVM level and for overload
      // resolution; Spoon may hand back the component type, so add the suffix
      // unless it is already there.
      if (parameter.isVarArgs() && !name.endsWith("[]")) {
        name = name + "[]";
      }
      rendered.add(name);
    }
    return "(" + String.join(",", rendered) + ")";
  }

  private static String renderParameterTypes(List<CtTypeReference<?>> types) {
    List<String> rendered = new ArrayList<>(types.size());
    for (CtTypeReference<?> type : types) {
      rendered.add(erasedTypeName(type));
    }
    return "(" + String.join(",", rendered) + ")";
  }

  /**
   * Unwraps arrays to their component type and type variables to their bound —
   * the same normalization {@link #forTypeReference} applies before naming a
   * type. Public because every caller that must decide "is this reference an
   * entity at all?" has to ask about the SAME type this class would name: asking
   * {@code isPrimitive()} of {@code int[]} answers false while the id resolves to
   * {@code int}, which is how primitive stub classes reached a real corpus.
   * Returns null for an unbounded type variable (JLS 4.6 erases it to Object).
   */
  public static CtTypeReference<?> elementTypeOf(CtTypeReference<?> reference) {
    CtTypeReference<?> current = reference;
    for (int guard = 0; guard < 64 && current != null; guard++) {
      if (current instanceof CtArrayTypeReference<?> array) {
        current = array.getComponentType();
      } else if (current instanceof CtTypeParameterReference typeParameter) {
        // null means "unbounded" — the caller maps that to java.lang.Object.
        current = typeParameter.getBoundingType();
      } else {
        return current;
      }
    }
    return current;
  }

  private static CtTypeReference<?> outermost(CtTypeReference<?> reference) {
    CtTypeReference<?> current = reference;
    for (int guard = 0; guard < 64; guard++) {
      CtTypeReference<?> declaring = current.getDeclaringType();
      if (declaring == null || declaring == current) {
        return current;
      }
      current = declaring;
    }
    return current;
  }

  /** The qualified name up to (excluding) the first nested-type separator. */
  private static String headOf(String qualifiedName) {
    int dollar = qualifiedName.indexOf('$');
    return dollar < 0 ? qualifiedName : qualifiedName.substring(0, dollar);
  }

  /**
   * Spoon writes nested types with {@code $}; ids use {@code .} throughout.
   *
   * <p>Type arguments are also cut here, because an id is erased by contract. For
   * a type Spoon RESOLVED they never reach the name, but for an unresolved one
   * they do: {@code new MutableConfiguration<>()} in noClasspath yields the name
   * {@code MutableConfiguration<>} (measured on spring-petclinic), which would
   * make {@code Foo<A>} and {@code Foo<B>} two entities for one type. A leading
   * {@code <} is left alone — that is the JVM's {@code <init>}/{@code <clinit>},
   * a name and not an argument list.
   */
  private static String normalizeName(String name) {
    if (name == null) {
      return "";
    }
    String trimmed = name.replace('$', '.').trim();
    int arguments = trimmed.indexOf('<');
    return arguments > 0 ? trimmed.substring(0, arguments) : trimmed;
  }

  /** Nearest enclosing type that has a name — anonymous classes are skipped. */
  private static CtType<?> enclosingNamedType(spoon.reflect.declaration.CtElement element) {
    CtType<?> type = element.getParent(CtType.class);
    while (type instanceof CtClass<?> c && c.isAnonymous()) {
      type = type.getParent(CtType.class);
    }
    if (type == null) {
      throw new IllegalArgumentException("element is not inside a named type: " + element.getClass());
    }
    return type;
  }

  private static int startLineOf(spoon.reflect.declaration.CtElement element) {
    spoon.reflect.cu.SourcePosition position = element.getPosition();
    if (position != null && position.isValidPosition()) {
      return position.getLine();
    }
    throw new IllegalArgumentException(
        "no valid source position for " + element.getClass().getSimpleName() + " — ids must not invent one");
  }

  private static String stripPrefix(String id) {
    requireText(id, "entity id");
    return id.startsWith(PREFIX) ? id.substring(PREFIX.length()) : id;
  }

  private static void requireText(String value, String what) {
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException(what + " must be non-blank");
    }
  }
}
