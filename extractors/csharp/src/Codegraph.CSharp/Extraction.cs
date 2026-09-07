using System.Reflection;
using Codegraph.CSharp.Model;

namespace Codegraph.CSharp;

public sealed record ExtractOptions(
    IReadOnlyList<string> Sources,
    string BaseDirectory,
    Repository? Repository = null,
    ImplicitUsings ImplicitUsings = ImplicitUsings.Sdk);

public sealed record ExtractionResult(ExtractedModel Model, ResolutionStats Stats, int Stubs);

/// <summary>
/// THE PASS ORDER, and why it is not negotiable (the Java extractor's, mirrored):
/// <code>
///   0. CorpusLoader.Load          one compilation, no MSBuild — unresolvable code still binds what it can
///   1. CorpusWhitelist.Build      what the corpus DECLARES — the only answer to "internal or external?"
///   2. EntityExtractor.Extract    nodes for declared constructs only
///   3. EdgeExtractor.Extract      relations, outgoing only, every one anchored
///   4. StubSynthesizer.Synthesize degraded nodes for what 2 and 3 REFERENCED but nothing DECLARED
///   5. JsonlWriter                sort, intern, number, write — byte-identical across runs and OSes
/// </code>
/// </summary>
public static class Extraction
{
    public const string Name = "codegraph-roslyn";

    public static string Version { get; } =
        typeof(Extraction).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? throw new InvalidOperationException("the assembly carries no informational version");

    public static ExtractionResult Run(ExtractOptions options, Progress progress)
    {
        var stats = new ResolutionStats();
        var corpus = CorpusLoader.Load(options.Sources, options.BaseDirectory, progress, options.ImplicitUsings);
        var whitelist = CorpusWhitelist.Build(corpus, progress);
        var registry = new TypeRegistry();
        var declarations = new EntityExtractor(whitelist, registry).Extract(corpus, progress);
        var entities = declarations.Entities;
        stats.DuplicateDeclarations = declarations.Duplicates;
        var edges = new EdgeExtractor(whitelist, declarations, registry, stats).Extract(corpus, progress);
        var stubs = StubSynthesizer.Synthesize(entities, edges, registry, progress);

        var model = new ExtractedModel
        {
            Extractor = new ExtractorInfo(Name, Version),
            Root = corpus.RootDisplay,
            Repository = options.Repository,
        };
        model.Entities.AddRange(entities);
        model.Entities.AddRange(stubs);
        model.Edges.AddRange(edges);
        return new ExtractionResult(model, stats, stubs.Count);
    }
}
