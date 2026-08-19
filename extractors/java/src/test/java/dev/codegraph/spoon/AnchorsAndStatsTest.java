package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.codegraph.spoon.model.SourceAnchor;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import spoon.Launcher;
import spoon.reflect.CtModel;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;

/**
 * Anchors and the resolution summary are implemented, not seams, and every
 * extraction pass depends on them — so they are exercised against a real corpus
 * on disk rather than a virtual one: relativization is the whole point.
 */
class AnchorsAndStatsTest {

  private static final String SOURCE =
      """
      package com.acme.order;

      public class OrderService {
        public Invoice bill(Order order) {
          return null;
        }
      }
      """;

  @Test
  void anchorsAreRootRelativeAndOneBased(@TempDir Path root) throws IOException {
    CtModel model = build(root);
    CtType<?> type = model.getAllTypes().iterator().next();
    Anchors anchors = new Anchors(root);

    Optional<SourceAnchor> anchor = anchors.of(type);
    assertTrue(anchor.isPresent());
    assertEquals("com/acme/order/OrderService.java", anchor.get().file());
    assertEquals(3, anchor.get().startLine());
    assertTrue(anchor.get().endLine() >= anchor.get().startLine());
  }

  @Test
  void orEnclosingFallsBackWhenAnElementHasNoValidPosition(@TempDir Path root) throws IOException {
    CtModel model = build(root);
    CtType<?> type = model.getAllTypes().iterator().next();
    CtMethod<?> method = type.getMethodsByName("bill").get(0);
    Anchors anchors = new Anchors(root);

    // Whether a type reference carries its own position varies; what must hold
    // is that walking up always yields evidence, because an edge without an
    // anchor is not emittable.
    SourceAnchor anchor = anchors.orEnclosing(method.getType()).orElseThrow();
    assertEquals("com/acme/order/OrderService.java", anchor.file());
    assertTrue(anchor.startLine() >= 1);
  }

  @Test
  void resolutionSummaryCountsUnresolvedReferences(@TempDir Path root) throws IOException {
    ResolutionStats stats = ResolutionStats.measure(build(root));

    assertTrue(stats.totalTypeReferences() > 0);
    // Invoice and Order exist nowhere — Spoon invents their FQNs, they resolve
    // to nothing, and that is exactly what the summary must report.
    assertTrue(stats.unresolvedTypeReferences() >= 2, "expected the invented types to count as unresolved");
    assertTrue(stats.resolutionRate() <= 1.0);

    String summary = stats.withOutput(12, 3, 20, 1).summary();
    assertTrue(summary.startsWith("RESOLUTION SUMMARY"));
    assertTrue(summary.contains("entities        : 12 (stubs: 3)"));
    assertTrue(summary.contains("edges           : 20 (self-edges dropped: 1)"));
    assertFalse(summary.contains("%d"));
  }

  private static CtModel build(Path root) throws IOException {
    Path file = root.resolve("com/acme/order/OrderService.java");
    Files.createDirectories(file.getParent());
    Files.writeString(file, SOURCE);

    Launcher launcher = new Launcher();
    launcher.getEnvironment().setNoClasspath(true);
    launcher.getEnvironment().setComplianceLevel(17);
    launcher.getEnvironment().setCommentEnabled(true);
    launcher.addInputResource(root.toString());
    return launcher.buildModel();
  }
}
