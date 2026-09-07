using Codegraph.CSharp.Model;

namespace Codegraph.CSharp.Tests;

/// <summary>Runs the extractor in-process over the committed fixture or an inline corpus.</summary>
public static class Harness
{
    /// <summary>The repository root: the ancestor holding both `schemas/` and `fixtures/`.</summary>
    public static string RepoRoot { get; } = FindRepoRoot();

    public const string FixtureRoot = "fixtures/csharp/src";
    public const string SnapshotPath = "fixtures/csharp/expected/model.jsonl";

    private static readonly Lazy<ExtractionResult> Fixture = new(() =>
        Extraction.Run(new ExtractOptions([FixtureRoot], RepoRoot), Progress.Silent));

    public static ExtractionResult FixtureResult => Fixture.Value;
    public static ExtractedModel FixtureModel => Fixture.Value.Model;
    public static string FixtureJsonl => JsonlWriter.Write(Fixture.Value.Model);

    /// <summary>An inline corpus: (relative path, source) pairs written to a scratch root, extracted, deleted.</summary>
    public static ExtractionResult Extract(params (string Path, string Source)[] files)
    {
        var scratch = Path.Combine(Path.GetTempPath(), "codegraph-csharp-" + Guid.NewGuid().ToString("n"));
        try
        {
            foreach (var (path, source) in files)
            {
                var full = Path.Combine(scratch, path);
                Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                File.WriteAllText(full, source);
            }
            return Extraction.Run(new ExtractOptions(["."], scratch), Progress.Silent);
        }
        finally
        {
            Directory.Delete(scratch, recursive: true);
        }
    }

    public static Entity EntityOf(ExtractedModel model, string renderedId) =>
        model.Entities.SingleOrDefault(e => e.Key.Render() == renderedId)
        ?? throw new Xunit.Sdk.XunitException($"no entity {renderedId}; have:\n  " + string.Join("\n  ", model.Entities.Select(e => e.Key.Render()).OrderBy(x => x, StringComparer.Ordinal)));

    public static Entity? Find(ExtractedModel model, string renderedId) =>
        model.Entities.SingleOrDefault(e => e.Key.Render() == renderedId);

    private static string FindRepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (Directory.Exists(Path.Combine(dir.FullName, "schemas")) && Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
                return dir.FullName;
        throw new InvalidOperationException("repository root (schemas/ + fixtures/) not found above " + AppContext.BaseDirectory);
    }
}
