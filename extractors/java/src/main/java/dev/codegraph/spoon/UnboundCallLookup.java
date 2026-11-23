package dev.codegraph.spoon;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Predicate;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtThisAccess;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtExecutableReference;
import spoon.reflect.reference.CtTypeReference;

/**
 * The method an unqualified call names in a body ECJ never resolved.
 *
 * <p>ECJ types a lambda from its functional interface. When that interface is not
 * on the classpath it resolves nothing of the lambda's body — nested lambdas
 * included — and Spoon hands every call there over with no declaring type, no
 * parameter types and a guessed {@code static}. Left alone, such a call is an
 * unidentifiable target and is dropped, so {@code cm -> helper()} leaves
 * {@code helper} uncalled.
 *
 * <p>What remains decidable without types is the lookup JLS §15.12.1 starts with:
 * the innermost enclosing type of which a method of that name is a member, then
 * the one method there whose arity accepts the call. Anything else — several
 * overloads of that arity, a name no enclosing type has, a qualified call — is
 * left unresolved rather than guessed.
 *
 * <p>A member set is only as complete as the corpus: a supertype outside it may
 * declare an overload of the same arity, or the very name an outer type also
 * declares. A resolution that consulted such a type is therefore marked
 * incomplete, and the caller says so in the edge's provenance.
 */
final class UnboundCallLookup {

  /**
   * Every type inherits these and no corpus declares them, so a call to one of
   * these names may land on {@code java.lang.Object} — undecidable here.
   */
  private static final Set<String> OBJECT_METHOD_NAMES =
      Set.of("clone", "equals", "finalize", "getClass", "hashCode", "notify", "notifyAll", "toString", "wait");

  /** {@code complete}: every type the lookup consulted had all its supertypes in the corpus. */
  record Resolution(CtMethod<?> method, boolean complete) {}

  private final Predicate<CtTypeReference<?>> inCorpus;

  /** @param inCorpus whether a type reference names a type the corpus declares (the whitelist's answer) */
  UnboundCallLookup(Predicate<CtTypeReference<?>> inCorpus) {
    this.inCorpus = inCorpus;
  }

  /** Empty unless the call is an unbound, unqualified call that names exactly one corpus method. */
  Optional<Resolution> resolve(CtInvocation<?> call) {
    CtExecutableReference<?> executable = call.getExecutable();
    if (executable == null
        || executable.getDeclaringType() != null
        || executable.isConstructor()
        || !(call.getTarget() instanceof CtThisAccess<?> receiver)
        || !receiver.isImplicit()
        || !insideAnUntypedLambda(call)) {
      return Optional.empty();
    }
    String name = executable.getSimpleName();
    if (OBJECT_METHOD_NAMES.contains(name)) {
      return Optional.empty();
    }
    int arguments = call.getArguments().size();
    boolean complete = true;
    for (CtType<?> type = enclosingType(call); type != null; type = enclosingType(type)) {
      Map<String, CtMethod<?>> members = new LinkedHashMap<>();
      complete &= collect(type, name, true, members, Collections.newSetFromMap(new IdentityHashMap<>()));
      if (!members.isEmpty()) {
        List<CtMethod<?>> applicable = new ArrayList<>();
        for (CtMethod<?> method : members.values()) {
          if (accepts(method, arguments)) {
            applicable.add(method);
          }
        }
        return applicable.size() == 1
            ? Optional.of(new Resolution(applicable.get(0), complete))
            : Optional.empty();
      }
    }
    return Optional.empty();
  }

  /**
   * The methods named {@code name} that {@code type} declares or inherits from
   * corpus supertypes, keyed by signature so an override hides what it overrides.
   * Returns whether every supertype on the way was a corpus type.
   */
  private boolean collect(
      CtType<?> type, String name, boolean own, Map<String, CtMethod<?>> members, Set<CtType<?>> visited) {
    if (!visited.add(type)) {
      return true;
    }
    for (CtMethod<?> method : type.getMethods()) {
      if (method.getSimpleName().equals(name) && (own || !method.isPrivate())) {
        members.putIfAbsent(EntityIds.signatureOf(method), method);
      }
    }
    boolean complete = true;
    List<CtTypeReference<?>> supertypes = new ArrayList<>();
    if (type.getSuperclass() != null) {
      supertypes.add(type.getSuperclass());
    }
    supertypes.addAll(type.getSuperInterfaces());
    for (CtTypeReference<?> supertype : supertypes) {
      CtType<?> declaration = inCorpus.test(supertype) ? declarationOf(supertype) : null;
      if (declaration == null) {
        complete = false;
      } else {
        complete &= collect(declaration, name, false, members, visited);
      }
    }
    return complete;
  }

  private static boolean accepts(CtMethod<?> method, int arguments) {
    List<CtParameter<?>> parameters = method.getParameters();
    boolean varargs = !parameters.isEmpty() && parameters.get(parameters.size() - 1).isVarArgs();
    return varargs ? arguments >= parameters.size() - 1 : arguments == parameters.size();
  }

  /** A lambda ECJ could not type reaches Spoon with no type; one it typed carries its interface. */
  private static boolean insideAnUntypedLambda(CtElement element) {
    for (CtElement current = element; current != null && current.isParentInitialized(); ) {
      current = current.getParent();
      if (current instanceof CtLambda<?> lambda && lambda.getType() == null) {
        return true;
      }
    }
    return false;
  }

  private static CtType<?> enclosingType(CtElement element) {
    try {
      return element.getParent(CtType.class);
    } catch (RuntimeException e) {
      return null;
    }
  }

  private static CtType<?> declarationOf(CtTypeReference<?> reference) {
    try {
      return reference.getTypeDeclaration();
    } catch (RuntimeException e) {
      return null;
    }
  }
}
