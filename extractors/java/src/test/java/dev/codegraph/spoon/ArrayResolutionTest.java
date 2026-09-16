package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import spoon.Launcher;
import spoon.reflect.CtModel;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtArrayTypeReference;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.visitor.filter.TypeFilter;
import spoon.support.reflect.reference.CtArrayTypeReferenceImpl;
import spoon.support.reflect.reference.CtTypeReferenceImpl;

/**
 * Spoon resolves an array reference by materialising its {@code Class} through
 * {@code Array.newInstance}. A native image can only do that for array classes
 * compiled into it, and the set a corpus writes ({@code float[][]},
 * {@code Map[][]}…) is unbounded — so the native binary died on BroadleafCommerce
 * with {@code MissingReflectionRegistrationError}. Resolution must answer for
 * arrays without building the array class, and give the JVM's answer doing so.
 */
class ArrayResolutionTest {

  private static final String SOURCE =
      """
      package p;

      import java.util.List;
      import java.util.Map;

      class A {
        float[][] matrix;
        int[] ints;
        String[][] strings;
        Map<String, List<Integer>>[][] maps;
        Object[][][][] deep;
        A[] own;
        A[][] owns;
        Missing[][] unknown;
        java.math.BigDecimal[][][] decimals;
      }
      """;

  @TempDir static Path root;

  private static CtModel model;

  @BeforeAll
  static void build() throws IOException {
    Path file = root.resolve("p/A.java");
    Files.createDirectories(file.getParent());
    Files.writeString(file, SOURCE);
    Launcher launcher = new Launcher();
    launcher.getEnvironment().setNoClasspath(true);
    launcher.getEnvironment().setComplianceLevel(17);
    launcher.addInputResource(root.toString());
    model = launcher.buildModel();
  }

  /** On a JVM Spoon's own answer is available, so it is the oracle: the rate must not move. */
  @Test
  void agreesWithSpoonOnTheJvm() {
    List<CtArrayTypeReference<?>> arrays = arrays();
    assertTrue(arrays.size() >= 9, () -> "the corpus lost its arrays: " + arrays);
    for (CtArrayTypeReference<?> array : arrays) {
      assertEquals(
          array.getTypeDeclaration() != null,
          ResolutionStats.resolves(array),
          () -> "resolution of " + array.getQualifiedName());
    }
  }

  @Test
  void neverMaterialisesTheArrayClass() {
    for (CtArrayTypeReference<?> array : arrays()) {
      CtArrayTypeReference<?> guarded = new UnbuildableArray();
      guarded.setFactory(array.getFactory());
      guarded.setComponentType(array.getComponentType().clone());
      // Throws, like the native image, if anything asks for the array's Class.
      ResolutionStats.resolves(guarded);
    }
    assertFalse(arrays().isEmpty());
  }

  /**
   * Spoon builds a nested JDK type's shadow from its enclosing class's; inside the
   * image {@code Thread}'s shadow has no {@code State}, and Spoon dereferences the
   * null. A reference Spoon cannot build is unresolved, not a failed run.
   */
  @Test
  void aShadowSpoonCannotBuildIsUnresolved() {
    CtTypeReference<?> broken = new UnbuildableShadow();
    broken.setFactory(model.getRootPackage().getFactory());
    broken.setSimpleName("State");
    assertFalse(ResolutionStats.resolves(broken));
  }

  private static List<CtArrayTypeReference<?>> arrays() {
    return model.getElements(new TypeFilter<CtTypeReference<?>>(CtTypeReference.class)).stream()
        .filter(reference -> reference instanceof CtArrayTypeReference<?>)
        .<CtArrayTypeReference<?>>map(reference -> (CtArrayTypeReference<?>) reference)
        .toList();
  }

  /** Stands in for the native image: Spoon's NPE on {@code Thread.State}. */
  @SuppressWarnings("rawtypes")
  private static final class UnbuildableShadow extends CtTypeReferenceImpl {
    @Override
    public CtType getTypeDeclaration() {
      throw new NullPointerException("no nested type State in the shadow of java.lang.Thread");
    }
  }

  /** Stands in for the native image: an array class that was never registered. */
  @SuppressWarnings("rawtypes")
  private static final class UnbuildableArray extends CtArrayTypeReferenceImpl {
    @Override
    public Class getActualClass() {
      throw new LinkageError("array class " + getQualifiedName() + " is not in the image");
    }
  }
}
