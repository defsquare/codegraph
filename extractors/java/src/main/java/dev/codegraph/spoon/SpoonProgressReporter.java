package dev.codegraph.spoon;

import java.util.EnumMap;
import java.util.Map;
import spoon.support.compiler.SpoonProgress;

/**
 * Bridges Spoon's own build progress onto the extractor's bar.
 *
 * <p>Pass 0 dominates the wall clock on a real corpus — on apache/fineract the
 * Spoon build is most of the run — and it is the one pass that can report
 * genuine per-file progress: Spoon walks its compilation units and calls
 * {@link SpoonProgress#step} with {@code (done, total)} for each of its
 * sub-processes. Each sub-process becomes one phase here, because their totals
 * are independent counts of the same files: folding them into a single bar
 * would make it run to 100% and start again, which is worse than saying plainly
 * which part of the build is running.
 *
 * <p>Sub-processes are sequential in Spoon (compile, then model, then imports,
 * then comment linking), so at most one phase is open at a time.
 */
final class SpoonProgressReporter implements SpoonProgress {

  private final Progress progress;
  private final Map<Process, Progress.Phase> phases = new EnumMap<>(Process.class);

  SpoonProgressReporter(Progress progress) {
    this.progress = progress;
  }

  @Override
  public void start(Process process) {
    // Deliberately does not open a phase. Spoon starts some sub-processes over
    // an empty unit list — measured on apache/fineract: MODEL, IMPORT and
    // COMMENT_LINKING each start a second time with nothing in them — and a
    // phase opened here would leave a "0 files" line for work that never
    // happened. The phase begins at the first step, which is the first evidence
    // that there is any.
  }

  @Override
  public void step(Process process, String task, int taskId, int nbTask) {
    Progress.Phase phase = phaseFor(process);
    phase.total(nbTask);
    phase.at(taskId);
    phase.detail(fileName(task));
  }

  @Override
  public void step(Process process, String task) {
    Progress.Phase phase = phaseFor(process);
    phase.step();
    phase.detail(fileName(task));
  }

  private Progress.Phase phaseFor(Process process) {
    // The total arrives with the step — Spoon does not announce it up front.
    return phases.computeIfAbsent(process, p -> progress.phase(label(p), "files"));
  }

  @Override
  public void end(Process process) {
    Progress.Phase phase = phases.remove(process);
    if (phase != null) {
      phase.close();
    }
  }

  /** Spoon's process names are internal; these are what the pass does. */
  private static String label(Process process) {
    switch (process) {
      case COMPILE:
        return "compile";
      case COMMENT:
        return "comments";
      case MODEL:
        return "model";
      case IMPORT:
        return "imports";
      case COMMENT_LINKING:
        return "link doc";
      case PROCESS:
        return "process";
      case PRINT:
        return "print";
      default:
        return process.name().toLowerCase(java.util.Locale.ROOT);
    }
  }

  /** The task is a full path; only the file name fits beside a bar. */
  private static String fileName(String task) {
    if (task == null) {
      return null;
    }
    int slash = task.lastIndexOf('/');
    return slash < 0 ? task : task.substring(slash + 1);
  }
}
