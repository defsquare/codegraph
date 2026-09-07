using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Codegraph.CSharp;

/// <summary>A namespace that directly holds at least one corpus type.</summary>
public sealed class CorpusNamespace(string module, INamespaceSymbol symbol)
{
    public string Module { get; } = module;
    public INamespaceSymbol Symbol { get; } = symbol;
    /// <summary>Files declaring a type directly in this namespace — `definedIn`.</summary>
    public SortedSet<string> Files { get; } = new(StringComparer.Ordinal);
    /// <summary>The block-scoped namespace declaration this one was written inside, if any.</summary>
    public INamespaceSymbol? SyntacticOuter { get; set; }
    /// <summary>Nearest enclosing corpus namespace by lexical nesting; null for file-scoped and dotted forms.</summary>
    public string? ParentModule { get; set; }
}

/// <summary>
/// Pass 1 — what the corpus DECLARES (PLAN.md §13.4). The only answer to
/// "internal or external?": a type symbol is internal iff one of its
/// declarations is in a source tree of the compilation. Never a namespace
/// prefix: a corpus type in `System.Acme` stays internal, and an unresolved
/// name in the corpus's own namespace stays a stub.
/// </summary>
public sealed class CorpusWhitelist
{
    private readonly HashSet<INamedTypeSymbol> declared = new(SymbolEqualityComparer.Default);
    private readonly List<INamedTypeSymbol> types = [];
    private readonly SortedDictionary<string, CorpusNamespace> namespaces = new(StringComparer.Ordinal);
    private readonly Dictionary<string, SortedSet<string>> modulesByFile = new(StringComparer.Ordinal);

    public IReadOnlyList<INamedTypeSymbol> Types => types;
    public IReadOnlyDictionary<string, CorpusNamespace> Namespaces => namespaces;

    public bool Contains(INamedTypeSymbol type) => declared.Contains(type.OriginalDefinition);

    public bool IsCorpusNamespace(string module) => namespaces.ContainsKey(module);

    /// <summary>Corpus namespaces with a type declared directly in this file, sorted.</summary>
    public IReadOnlyCollection<string> ModulesDeclaredIn(string file) =>
        modulesByFile.TryGetValue(file, out var modules) ? modules : [];

    /// <summary>The nearest corpus namespace at or above `ns`, or null when none holds a corpus type.</summary>
    public string? NearestCorpusNamespace(INamespaceSymbol? ns)
    {
        for (var n = ns; n is not null; n = n.ContainingNamespace)
        {
            var module = Ids.ModuleOf(n);
            if (namespaces.ContainsKey(module)) return module;
            if (n.IsGlobalNamespace) break;
        }
        return null;
    }

    public static CorpusWhitelist Build(Corpus corpus, Progress progress) =>
        progress.Phase("whitelist", () =>
        {
            var whitelist = new CorpusWhitelist();
            foreach (var tree in corpus.Trees)
            {
                var model = corpus.Compilation.GetSemanticModel(tree);
                foreach (var node in tree.GetRoot().DescendantNodes())
                {
                    if (node is not (BaseTypeDeclarationSyntax or DelegateDeclarationSyntax)) continue;
                    if (model.GetDeclaredSymbol(node) is not INamedTypeSymbol symbol) continue;
                    whitelist.Add(symbol, node, model);
                }
            }
            whitelist.ResolveParents();
            return whitelist;
        }, w => $"{w.types.Count:N0} types");

    private void Add(INamedTypeSymbol symbol, SyntaxNode node, SemanticModel model)
    {
        if (declared.Add(symbol.OriginalDefinition)) types.Add(symbol.OriginalDefinition);
        if (symbol.ContainingType is not null) return;

        var module = Ids.ModuleOf(symbol.ContainingNamespace);
        if (!namespaces.TryGetValue(module, out var ns))
        {
            ns = new CorpusNamespace(module, symbol.ContainingNamespace);
            namespaces[module] = ns;
        }
        var file = node.SyntaxTree.FilePath;
        ns.Files.Add(file);
        if (!modulesByFile.TryGetValue(file, out var modules)) modulesByFile[file] = modules = new SortedSet<string>(StringComparer.Ordinal);
        modules.Add(module);

        // A nested block — `namespace A { namespace B { … } }` — is the one form
        // that writes a lexical parent; a dotted or file-scoped one does not.
        var enclosing = Syntax.EnclosingNamespace(node);
        var outer = enclosing is null ? null : Syntax.EnclosingNamespace(enclosing);
        if (outer is not null && ns.SyntacticOuter is null && model.GetDeclaredSymbol(outer) is INamespaceSymbol outerSymbol)
            ns.SyntacticOuter = outerSymbol;
    }

    private void ResolveParents()
    {
        foreach (var ns in namespaces.Values)
        {
            if (ns.SyntacticOuter is null) continue;
            var parent = NearestCorpusNamespace(ns.SyntacticOuter);
            if (parent is not null && parent != ns.Module && parent != NaturalKey_GlobalModule) ns.ParentModule = parent;
        }
    }

    private const string NaturalKey_GlobalModule = Model.NaturalKey.GlobalModule;
}
