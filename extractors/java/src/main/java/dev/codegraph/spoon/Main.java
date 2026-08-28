package dev.codegraph.spoon;

import dev.codegraph.spoon.model.Edge;
import dev.codegraph.spoon.model.Entity;
import dev.codegraph.spoon.model.ExtractorInfo;
import dev.codegraph.spoon.model.Model;
import dev.codegraph.spoon.model.JsonlWriter;
import dev.codegraph.spoon.model.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import spoon.Launcher;
import spoon.reflect.CtModel;

/**
 * CLI: {@code java -jar codegraph-java.jar [--src <dir>…] [--out <file>]} — bare, it
 * extracts the current directory into {@code <current-dir>-codegraph.jsonl}.
 *
 * <p>THE PASS ORDER, and why it is not negotiable:
 *
 * <pre>
 *   0. build the Spoon model            noClasspath: unresolvable code still parses
 *   1. CorpusWhitelist.build            what the corpus DECLARES — before anything
 *                                       else, because it is the only answer to
 *                                       "internal or external?" that Spoon's
 *                                       invented FQNs cannot fake (PLAN.md §5.2)
 *   2. EntityExtractor.extract          nodes for declared constructs only
 *   3. EdgeExtractor.extract            relations, outgoing only, every one anchored
 *   4. StubSynthesizer.synthesize       degraded nodes for what 2 and 3 REFERENCED
 *                                       but nothing DECLARED — driven by observed
 *                                       references, not by a guess about the corpus
 *   5. sort, write, summarize           byte-identical output across runs
 * </pre>
 *
 * Pass 4 cannot run before pass 3: stubs exist because something referenced them.
 * Passes 2 and 3 cannot run before pass 1: without the whitelist, membership
 * degenerates into a prefix test, which is the one thing M2 must never do.
 */
public final class Main {

  private static final String NAME = "codegraph-spoon";
  private static final String VERSION = "0.2.0";
  private static final int COMPLIANCE_LEVEL = 17;

  private static final int EXIT_USAGE = 2;
  private static final int EXIT_UNIMPLEMENTED = 3;

  private Main() {}

  public static void main(String[] args) {
    Options options;
    try {
      options = Options.parse(args);
    } catch (IllegalArgumentException e) {
      System.err.println("error: " + e.getMessage());
      System.err.println();
      System.err.print(usage());
      System.exit(EXIT_USAGE);
      return;
    }

    if (options.help()) {
      System.out.print(usage());
      return;
    }

    try {
      run(options);
    } catch (UnsupportedOperationException e) {
      // Expected until the extraction passes land: the wiring is live, the pass is not.
      System.err.println("error: unimplemented extraction pass: " + e.getMessage());
      System.exit(EXIT_UNIMPLEMENTED);
    } catch (Exception e) {
      System.err.println("error: " + describe(e));
      System.exit(1);
    }
  }

  private static void run(Options options) throws Exception {
    try (Progress progress = Progress.forMode(options.progress())) {
      run(options, progress);
    }
  }

  private static void run(Options options, Progress progress) throws Exception {
    Path root = commonRoot(options.sources());

    // Pass 0 — the Spoon model. noClasspath is the whole point: legacy corpora
    // do not compile, and an extractor that requires a classpath extracts nothing.
    // Spoon reports its own per-file progress; on a real corpus this pass is most
    // of the wall clock, so it is the one that most needs a bar.
    Launcher launcher = new Launcher();
    launcher.getEnvironment().setNoClasspath(true);
    // A multi-module corpus may declare one FQN in several modules (each compiles
    // alone); Spoon sees all roots as one unit and JDT's duplicate-type error
    // would abort the run. Keep the first declaration, drop the rest — same
    // simple name in DIFFERENT packages is never a duplicate.
    launcher.getEnvironment().setIgnoreDuplicateDeclarations(true);
    launcher.getEnvironment().setComplianceLevel(COMPLIANCE_LEVEL);
    launcher.getEnvironment().setCommentEnabled(true);
    if (progress.isEnabled()) {
      launcher.getEnvironment().setSpoonProgress(new SpoonProgressReporter(progress));
    }
    for (Path source : options.sources()) {
      launcher.addInputResource(source.toString());
    }
    CtModel spoonModel = launcher.buildModel();

    ResolutionStats stats = ResolutionStats.measure(spoonModel);
    Anchors anchors = new Anchors(root);

    // Pass 1 — corpus membership, decided once and consulted by everything after.
    // The anchors matter: lambda/anonymous ids embed the root-relative file, so the
    // whitelist must use the SAME Anchors as pass 2, or their ids disagree.
    CorpusWhitelist whitelist = CorpusWhitelist.build(spoonModel, anchors, progress);

    // Pass 2 — declared entities.
    List<Entity> declared = new EntityExtractor(whitelist, anchors).extract(spoonModel, progress);

    // Pass 3 — relations; self-edges are not representable in the metamodel.
    List<Edge> allEdges = new EdgeExtractor(whitelist, anchors).extract(spoonModel, progress);
    List<Edge> edges = new ArrayList<>(allEdges.size());
    int droppedSelfEdges = 0;
    for (Edge edge : allEdges) {
      if (edge.selfReference()) {
        droppedSelfEdges++;
      } else {
        edges.add(edge);
      }
    }

    // Pass 4 — stubs for what was referenced but never declared.
    Set<String> dangling = danglingReferences(declared, edges);
    List<Entity> stubs;
    try (Progress.Phase phase = progress.phase("stubs", dangling.size(), "references")) {
      stubs = new StubSynthesizer().synthesize(dangling, whitelist);
      phase.at(dangling.size());
    }

    List<Entity> entities = new ArrayList<>(declared.size() + stubs.size());
    entities.addAll(declared);
    entities.addAll(stubs);

    // Pass 4.5 — anything pass 4 refused to fabricate is still dangling, and the
    // interchange cannot express it: a reference travels as a surrogate, and
    // there is no surrogate for an entity nobody declared. v1 wrote such an edge
    // and left the analyzer to report it; the format now forces the choice here,
    // so the edge is DROPPED and counted rather than silently reinterpreted.
    // An unresolvable member id is the case this exists for (METAMODEL.md §6).
    Set<String> declaredIds = new java.util.HashSet<>();
    for (Entity entity : entities) {
      declaredIds.add(entity.id());
    }
    List<Edge> closed = new ArrayList<>(edges.size());
    int droppedDanglingEdges = 0;
    for (Edge edge : edges) {
      if (declaredIds.contains(edge.from()) && declaredIds.contains(edge.to())) {
        closed.add(edge);
      } else {
        droppedDanglingEdges++;
        progress.log(
            "warning: dropped an edge whose endpoint nothing declares: "
                + edge.from()
                + " -> "
                + edge.to());
      }
    }
    edges = closed;

    // Pass 5 — deterministic assembly and output.
    ExtractorInfo extractor = new ExtractorInfo(NAME, VERSION, Boolean.TRUE);
    Model model = Model.sorted(extractor, root.toString(), options.repository(), entities, edges);
    try (Progress.Phase phase = progress.phase("write", "records")) {
      new JsonlWriter().write(model, options.out(), observing(phase));
    }

    progress.log(
        stats.withOutput(entities.size(), stubs.size(), edges.size(), droppedSelfEdges).summary());
    if (droppedDanglingEdges > 0) {
      progress.log(
          "warning: " + droppedDanglingEdges + " edge(s) dropped for an undeclarable endpoint");
    }

    notice(options);
  }

  /**
   * What was read and where it landed — the only thing this run writes to stdout,
   * every diagnostic staying on stderr. Absolute and normalized: both options
   * default, and both may be relative to a working directory the caller has left,
   * so the notice has to be copyable into the next command as-is.
   */
  private static void notice(Options options) {
    for (Path source : options.sources()) {
      System.out.println("source: " + source.toAbsolutePath().normalize());
    }
    System.out.println("model:  " + options.out().toAbsolutePath().normalize());
  }

  /** The writer counts records; the bar shows them. */
  private static JsonlWriter.Observer observing(Progress.Phase phase) {
    return new JsonlWriter.Observer() {
      @Override
      public void total(long records) {
        phase.total(records);
      }

      @Override
      public void written(long records) {
        phase.at(records);
      }
    };
  }

  /**
   * Ids that pass 2 and pass 3 pointed at but pass 2 never emitted — the exact
   * input pass 4 needs. Sorted, so the stub set is deterministic too.
   */
  private static Set<String> danglingReferences(List<Entity> declared, List<Edge> edges) {
    Set<String> known = new java.util.HashSet<>();
    for (Entity entity : declared) {
      known.add(entity.id());
    }

    Set<String> referenced = new TreeSet<>();
    for (Entity entity : declared) {
      addIfPresent(referenced, entity.declaredType());
      addIfPresent(referenced, entity.parent());
      addIfPresent(referenced, entity.attachedTo());
      addAll(referenced, entity.parameters());
      addAll(referenced, entity.localVariables());
    }
    for (Edge edge : edges) {
      addIfPresent(referenced, edge.from());
      addIfPresent(referenced, edge.to());
      addAll(referenced, edge.candidates());
    }
    referenced.removeAll(known);
    return referenced;
  }

  private static void addIfPresent(Set<String> target, String id) {
    if (id != null && !id.isBlank()) {
      target.add(id);
    }
  }

  private static void addAll(Set<String> target, List<String> ids) {
    if (ids != null) {
      for (String id : ids) {
        addIfPresent(target, id);
      }
    }
  }

  /**
   * Anchors are relative to a single root (METAMODEL.md §8). With several
   * {@code --src} roots that is their deepest common ancestor, so no anchor ever
   * needs an absolute path.
   */
  static Path commonRoot(List<Path> sources) {
    // Canonical throughout: startsWith over mixed symlink forms would walk the
    // common ancestor all the way up to "/" and make every anchor absolute.
    Path common = Anchors.canonical(sources.get(0));
    if (!Files.isDirectory(common)) {
      common = common.getParent();
    }
    for (int i = 1; i < sources.size(); i++) {
      Path candidate = Anchors.canonical(sources.get(i));
      while (common != null && !candidate.startsWith(common)) {
        common = common.getParent();
      }
    }
    return common == null ? Path.of("/") : common;
  }

  private static String describe(Exception e) {
    String message = e.getMessage();
    return (message == null || message.isBlank()) ? e.toString() : message;
  }

  private static String usage() {
    return """
        codegraph-java %s — Spoon-based Java extractor

        USAGE
          java -jar codegraph-java.jar [--src <dir>…] [--out <file>]

        OPTIONS
          --src <dir>    source root to analyze; repeatable (default: the current
                         directory)
          --out <file>   where to write the model (default:
                         <current-dir>-codegraph.jsonl)
          --progress <m> auto (default: a bar on a terminal, silence when piped),
                         plain (one line per phase, no control characters), or none
          --no-progress  same as --progress none
          --help         print this and exit

        REPOSITORY PROVENANCE (copied verbatim into the header; the extractor runs
        no git — whoever invokes it supplies the facts, e.g. codegraph snapshots)
          --repo-remote <url>   normalized https clone URL, no .git suffix
          --repo-commit <sha>   the sha this tree is at — a permalink, not a branch
          --repo-root <path>    the analyzed root RELATIVE to the repository root
                                (default: empty — they are the same directory)
          --repo-provider <p>   github | gitlab, only when the hostname does not say

        The run prints a RESOLUTION SUMMARY to stderr: how many type references
        Spoon resolved in noClasspath mode, how many entities and stubs were
        emitted, and how many edges. Progress goes to stderr too, and never to a
        stream that is not a terminal unless asked for. stdout carries one thing:
        the finished run's `source:` roots and `model:` file, absolute.
        """
        .formatted(VERSION);
  }

  /** Hand-rolled parsing: an argument parser is not worth a dependency here. */
  record Options(
      List<Path> sources,
      Path out,
      boolean help,
      Progress.Mode progress,
      /** Repository facts to copy into the header; null when the run was told none. */
      Repository repository) {

    private static final Path CURRENT_DIRECTORY = Path.of(".");

    /**
     * {@code <current-dir>-codegraph.jsonl}, beside the corpus it describes. Kept
     * relative so the name follows the process's working directory rather than
     * where the jar happens to live; the filesystem root has no name, hence the
     * fallback.
     */
    private static Path defaultOut() {
      Path name = Path.of("").toAbsolutePath().normalize().getFileName();
      return Path.of((name == null ? "" : name + "-") + "codegraph.jsonl");
    }

    static Options parse(String[] args) {
      Set<Path> sources = new LinkedHashSet<>();
      Path out = null;
      Progress.Mode progress = Progress.Mode.AUTO;
      String remote = null;
      String commit = null;
      String repoRoot = null;
      String provider = null;

      for (int i = 0; i < args.length; i++) {
        String arg = args[i];
        switch (arg) {
          case "--help", "-h" -> {
            return new Options(List.of(), null, true, Progress.Mode.NONE, null);
          }
          case "--src" -> sources.add(Path.of(value(args, ++i, "--src")));
          case "--out" -> out = Path.of(value(args, ++i, "--out"));
          case "--progress" -> progress = Progress.Mode.parse(value(args, ++i, "--progress"));
          case "--no-progress" -> progress = Progress.Mode.NONE;
          case "--repo-remote" -> remote = value(args, ++i, "--repo-remote");
          case "--repo-commit" -> commit = value(args, ++i, "--repo-commit");
          case "--repo-root" -> repoRoot = value(args, ++i, "--repo-root");
          case "--repo-provider" -> provider = value(args, ++i, "--repo-provider");
          default -> throw new IllegalArgumentException("unknown option: " + arg);
        }
      }

      if (sources.isEmpty()) {
        sources.add(CURRENT_DIRECTORY);
      }
      if (out == null) {
        out = defaultOut();
      }
      for (Path source : sources) {
        if (!Files.exists(source)) {
          throw new IllegalArgumentException("source root does not exist: " + source);
        }
      }
      return new Options(List.copyOf(sources), out, false, progress, repository(remote, commit, repoRoot, provider));
    }

    /**
     * The facts travel together: a remote without a sha (or the reverse) links
     * nowhere, so a half-given block is a usage error rather than a header
     * consumers must second-guess. Only {@code --repo-root} has a meaningful
     * default — the analyzed root IS the repository root.
     */
    private static Repository repository(String remote, String commit, String root, String provider) {
      if (remote == null && commit == null && root == null && provider == null) {
        return null;
      }
      if (remote == null || commit == null) {
        throw new IllegalArgumentException(
            "--repo-remote and --repo-commit are needed together (add --repo-root when the "
                + "analyzed root sits below the repository root)");
      }
      return new Repository(remote, commit, root == null ? "" : root, provider);
    }

    private static String value(String[] args, int index, String option) {
      if (index >= args.length) {
        throw new IllegalArgumentException(option + " needs a value");
      }
      return args[index];
    }
  }
}
