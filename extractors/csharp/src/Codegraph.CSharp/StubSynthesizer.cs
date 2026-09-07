using Codegraph.CSharp.Model;
using Microsoft.CodeAnalysis;

namespace Codegraph.CSharp;

/// <summary>
/// Pass 4 — degraded nodes for what passes 2 and 3 REFERENCED but nothing
/// DECLARED (METAMODEL.md §6). Driven by observed references, never by a guess
/// about the corpus: a type stub is `{TNamed, TType, TChildOf, isStub}` under
/// its stub module (the M3 containment decision), a module stub is
/// `{TNamed, TModule, TWithChildren, definedIn: [], isStub}`. Metadata types
/// keep their real kind and simple name; error types are `class`.
/// </summary>
public static class StubSynthesizer
{
    public static List<Entity> Synthesize(IReadOnlyList<Entity> declared, IReadOnlyList<Edge> edges, TypeRegistry registry, Progress progress) =>
        progress.Phase("stubs", () =>
        {
            var known = new HashSet<NaturalKey>(declared.Select(e => e.Key));
            var referenced = new SortedSet<NaturalKey>();
            foreach (var entity in declared) foreach (var key in entity.References()) referenced.Add(key);
            foreach (var edge in edges) foreach (var key in edge.References()) referenced.Add(key);

            var stubs = new List<Entity>();
            var pending = new Queue<NaturalKey>(referenced.Where(k => !known.Contains(k)));
            while (pending.Count > 0)
            {
                var key = pending.Dequeue();
                if (!known.Add(key)) continue;
                if (key.IsModule)
                {
                    var module = new Entity { Key = key, Kind = Kinds.Namespace }
                        .With(Traits.TNamed, Traits.TModule, Traits.TWithChildren);
                    module.Name = key.Module;
                    module.DefinedIn = [];
                    module.IsStub = true;
                    stubs.Add(module);
                    continue;
                }
                if (key.Disambiguator is not null)
                    throw new InvalidOperationException($"a dangling member reference cannot be degraded into a stub: {key}");
                var symbol = registry.SymbolOf(key);
                var type = new Entity { Key = key, Kind = symbol is null ? Kinds.Class : EntityExtractor.KindOf(symbol) }
                    .With(Traits.TNamed, Traits.TType, Traits.TChildOf);
                type.Name = symbol?.Name ?? SimpleName(key.Symbol);
                type.IsStub = true;
                type.Parent = key.ModuleKey;
                stubs.Add(type);
                pending.Enqueue(key.ModuleKey);
            }
            return stubs;
        }, list => $"{list.Count:N0} stubs");

    private static string SimpleName(string symbol)
    {
        var last = symbol.LastIndexOf('.');
        var name = last < 0 ? symbol : symbol[(last + 1)..];
        var tick = name.IndexOf('`');
        return tick < 0 ? name : name[..tick];
    }
}
