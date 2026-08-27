package dev.codegraph.spoon.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.regex.Pattern;

/**
 * Where the analyzed corpus lives in a hosted repository (METAMODEL.md §8a).
 * Facts only — the extractor has no git knowledge and invents nothing: the
 * three strings arrive on the command line and are copied verbatim.
 *
 * <p>The patterns below are the ones published in
 * {@code schemas/header.record.schema.json}. Checking them here is conformance,
 * not metamodel intelligence: a value the contract cannot express would produce
 * a model the analyzer refuses whole, so the flag is where it must be caught.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"remote", "commit", "root", "provider"})
public record Repository(String remote, String commit, String root, String provider) {

  private static final Pattern REMOTE =
      Pattern.compile("^https://(?![^\\s]*\\.git$)[^\\s?#]*[^\\s?#/]$");
  private static final Pattern COMMIT = Pattern.compile("^[0-9a-f]{7,64}$");
  private static final Pattern ROOT =
      Pattern.compile("^$|^(?!\\.\\.?(?:/|$))[^/\\s]+(?:/(?!\\.\\.?(?:/|$))[^/\\s]+)*$");

  public Repository {
    if (remote == null || !REMOTE.matcher(remote).matches()) {
      throw new IllegalArgumentException(
          "--repo-remote must be a normalized https URL with no .git suffix "
              + "(https://github.com/owner/repo), got: "
              + remote);
    }
    if (commit == null || !COMMIT.matcher(commit).matches()) {
      throw new IllegalArgumentException(
          "--repo-commit must be a lowercase hex sha — a branch name moves and is not a fact, got: "
              + commit);
    }
    if (root == null || !ROOT.matcher(root).matches()) {
      throw new IllegalArgumentException(
          "--repo-root must be the analyzed root relative to the repository root "
              + "(empty when they are the same directory), got: "
              + root);
    }
    if (provider != null && !provider.equals("github") && !provider.equals("gitlab")) {
      throw new IllegalArgumentException("--repo-provider must be github or gitlab, got: " + provider);
    }
  }
}
