package dev.codegraph.spoon;

import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.eclipse.jdt.core.compiler.CategorizedProblem;
import org.eclipse.jdt.core.compiler.IProblem;
import spoon.Launcher;
import spoon.SpoonModelBuilder;
import spoon.reflect.factory.Factory;
import spoon.support.compiler.jdt.JDTBasedSpoonCompiler;

/**
 * A {@link Launcher} for CORPORA rather than for one compilation unit.
 *
 * <p>Spoon compiles every {@code --src} root as a single JDT batch. A multi-module
 * build is not one: Maven and Gradle give each module its own source roots, so two
 * modules may declare the same fully-qualified name and both compile, each seeing
 * only its own. Batched together that is {@link IProblem#DuplicateTypes}, and
 * Spoon's default answer is a fatal {@code ModelBuildingException} that takes the
 * whole corpus with it — measured on a real repository, one collision in a test
 * helper aborted the extraction of 4,972 files. Analyzing a corpus cannot be
 * conditional on the corpus being compilable as a unit, so this launcher tolerates
 * the collision.
 *
 * <p>Tolerating is not hiding. JDT keeps the FIRST declaration it reached and
 * discards every later one, so the discarded file contributes no entity and no
 * edge: the loss is real, and {@link #shadowedDeclarations()} reports it for the
 * caller to say so. The interception has to happen here because Spoon drops the
 * problem on the floor once ignoring is on — {@code reportProblem} returns before
 * recording it, so {@code getProblems()} afterwards is empty.
 */
final class CorpusLauncher extends Launcher {

  /**
   * NOTE: this class must stay free of instance fields. {@link #getCompilerInstance}
   * is called from {@link Launcher}'s constructor, before a subclass field would be
   * assigned, so any state read there would still be null.
   */
  CorpusLauncher() {
    getEnvironment().setIgnoreDuplicateDeclarations(true);
  }

  @Override
  protected SpoonModelBuilder getCompilerInstance(Factory factory) {
    return new DuplicateTolerantCompiler(factory);
  }

  /** Declarations JDT discarded, in the order it reached them. Empty for a corpus with no collision. */
  List<Shadowed> shadowedDeclarations() {
    return getModelBuilder() instanceof DuplicateTolerantCompiler compiler
        ? List.copyOf(compiler.shadowed)
        : List.of();
  }

  /**
   * One declaration that is absent from the model because an earlier file declared
   * the same name, with JDT's own words for why.
   */
  record Shadowed(Path file, String message) {}

  private static final class DuplicateTolerantCompiler extends JDTBasedSpoonCompiler {

    /** A set, because JDT may raise the same collision once per compilation unit involved. */
    private final Set<Shadowed> shadowed = new LinkedHashSet<>();

    DuplicateTolerantCompiler(Factory factory) {
      super(factory);
    }

    @Override
    public void reportProblem(CategorizedProblem problem) {
      if (problem != null && problem.getID() == IProblem.DuplicateTypes) {
        char[] origin = problem.getOriginatingFileName();
        if (origin != null && origin.length > 0) {
          shadowed.add(new Shadowed(Path.of(new String(origin)), problem.getMessage()));
        }
      }
      super.reportProblem(problem);
    }
  }
}
