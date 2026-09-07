using Codegraph.CSharp.Model;
using Microsoft.CodeAnalysis;

namespace Codegraph.CSharp;

/// <summary>
/// Pass 2's result: the declared entities plus the two maps pass 3 needs —
/// symbol → key, so an edge target names the entity actually emitted, and
/// declaration node → key, so an edge's source is the nearest ancestor the
/// corpus declares (the Java extractor's `ownerOf`, mirrored).
///
/// A corpus is not a compilation unit. Two projects that never see each other
/// may both declare `static class Extensions { AddApplicationServices(…) }`
/// in the global namespace, and ten services each have a top-level
/// `Program.cs` (found on dotnet/eShop); in ONE compilation they are one type
/// with several same-keyed members. Every one is KEPT: the first declaration
/// in ordinal file order owns the plain key, each later one is re-keyed by
/// the file it is written in (`…#in:Catalog.API/Program.cs`) — a source fact,
/// like a lambda's position — and the re-keying is named on stderr. Dropping
/// the later ones (the JDT rule the Java profile documents) would erase the
/// DI wiring of nine services out of ten.
/// </summary>
public sealed class Declarations
{
    public List<Entity> Entities { get; } = [];
    public Dictionary<ISymbol, NaturalKey> KeyOfSymbol { get; } = new(SymbolEqualityComparer.Default);
    public Dictionary<SyntaxNode, NaturalKey> KeyOfNode { get; } = [];
    /// <summary>Keys of the declared TYPES — what a member's or lambda's symbol path is cut back to.</summary>
    public HashSet<NaturalKey> TypeKeys { get; } = [];
    /// <summary>Every same-keyed declaration re-keyed, as `key -> key#in:file`, in the order met.</summary>
    public List<string> Duplicates { get; } = [];

    private readonly HashSet<NaturalKey> keys = [];

    /// <summary>Adds the entity, re-keying it by file when its key is already declared; returns the key it carries.</summary>
    public NaturalKey Declare(Entity entity, ISymbol? symbol, params SyntaxNode?[] nodes)
    {
        if (!keys.Add(entity.Key))
        {
            var where = nodes.FirstOrDefault(n => n is not null);
            var file = where?.SyntaxTree.FilePath ?? entity.Anchor?.File ?? "?";
            var original = entity.Key;
            var tail = "in:" + file;
            entity.Key = new NaturalKey(original.Module, original.Symbol, original.Disambiguator is null ? tail : original.Disambiguator + "#" + tail);
            if (!keys.Add(entity.Key))
                throw new InvalidOperationException($"two declarations of {original} in one file: {file}");
            Duplicates.Add($"{original.Render()} -> {entity.Key.Render()}");
        }
        Entities.Add(entity);
        if (entity.Has(Traits.TType)) TypeKeys.Add(entity.Key);
        if (symbol is not null) KeyOfSymbol.TryAdd(symbol, entity.Key);
        foreach (var node in nodes) if (node is not null) KeyOfNode.TryAdd(node, entity.Key);
        return entity.Key;
    }

    /// <summary>The key of the nearest declared ancestor (or self) of a syntax node, if any.</summary>
    public NaturalKey? OwnerOf(SyntaxNode node)
    {
        for (var n = node; n is not null; n = n.Parent)
            if (KeyOfNode.TryGetValue(n, out var key)) return key;
        return null;
    }

    /// <summary>
    /// Where an edge to a member points (PLAN §13.4): the member's own entity
    /// when the corpus declares it and pass 2 emitted it; otherwise its
    /// containing TYPE — the Java rule for members of stubs, applied as well to
    /// the members Roslyn synthesizes and nobody wrote (record `Equals`, a
    /// delegate's `Invoke`, an accessor). A call to `Money.Equals` is still a
    /// dependency on `Money`.
    /// </summary>
    public NaturalKey? TargetOf(ISymbol symbol, TypeRegistry registry)
    {
        var definition = Definition(symbol);
        if (KeyOfSymbol.TryGetValue(definition, out var key)) return key;
        if (definition is INamedTypeSymbol type) return registry.Note(type);
        if (definition is IMethodSymbol { MethodKind: MethodKind.LocalFunction or MethodKind.AnonymousFunction }) return null;
        return definition.ContainingType is { } owner ? registry.Note(owner) : null;
    }

    public static ISymbol Definition(ISymbol symbol)
    {
        if (symbol is IMethodSymbol method)
        {
            if (method.ReducedFrom is not null) method = method.ReducedFrom;
            if (method.PartialDefinitionPart is not null) method = method.PartialDefinitionPart;
            return method.OriginalDefinition;
        }
        return symbol.OriginalDefinition;
    }
}
