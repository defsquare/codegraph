using Codegraph.CSharp.Model;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Codegraph.CSharp;

/// <summary>
/// Pass 3 — relations, outgoing only, every one anchored (M12a: `import`,
/// `inheritance`, `interfaceImplementation`). A self-edge is not representable
/// (METAMODEL.md §4) and is dropped and counted; so is a `using` in a file that
/// declares no corpus module to hang it on.
/// </summary>
public sealed class EdgeExtractor(CorpusWhitelist whitelist, TypeRegistry registry, ResolutionStats stats)
{
    private readonly HashSet<(string, NaturalKey, NaturalKey, string, int, int, string)> seen = [];

    public List<Edge> Extract(Corpus corpus, Progress progress) =>
        progress.Phase("edges", () =>
        {
            var edges = new List<Edge>();
            foreach (var tree in corpus.Trees) Imports(corpus, tree, edges);
            foreach (var type in whitelist.Types) BaseList(corpus, type, edges);
            return edges;
        }, list => $"{list.Count:N0} edges");

    // ------------------------------------------------------------ imports --

    /// <summary>
    /// `using X;` → import from the module(s) the directive scopes over to `X`:
    /// a compilation-unit directive scopes over every corpus namespace with a
    /// type declared in this file; one inside a namespace block over the
    /// nearest corpus namespace enclosing it. `using static T` and an alias to
    /// a type fold to T's namespace — imports are module-level, never a type.
    /// </summary>
    private void Imports(Corpus corpus, SyntaxTree tree, List<Edge> edges)
    {
        var model = corpus.Compilation.GetSemanticModel(tree);
        foreach (var directive in tree.GetRoot().DescendantNodes().OfType<UsingDirectiveSyntax>())
        {
            var target = ImportTarget(model, directive);
            if (target is null) continue;

            IReadOnlyCollection<string> froms;
            var enclosing = Syntax.EnclosingNamespace(directive);
            if (enclosing is null)
                froms = whitelist.ModulesDeclaredIn(tree.FilePath);
            else
            {
                var nearest = whitelist.NearestCorpusNamespace(model.GetDeclaredSymbol(enclosing) as INamespaceSymbol);
                froms = nearest is null ? [] : [nearest];
            }
            if (froms.Count == 0) { stats.ImportsWithoutModule++; continue; }

            var anchor = Syntax.AnchorOf(directive);
            foreach (var from in froms)
                Add(edges, new Edge(EdgeKinds.Import, NaturalKey.OfModule(from), target, Provenance.Declared, anchor));
        }
    }

    private NaturalKey? ImportTarget(SemanticModel model, UsingDirectiveSyntax directive)
    {
        var name = directive.NamespaceOrType;
        var symbol = model.GetSymbolInfo(name).Symbol;
        switch (symbol)
        {
            case INamespaceSymbol ns:
                stats.NoteImport(resolved: true);
                return ns.IsGlobalNamespace ? null : Ids.Namespace(ns);
            case INamedTypeSymbol type when type.TypeKind != TypeKind.Error:
                stats.NoteImport(resolved: true);
                registry.Note(type);
                return Ids.Namespace(type.ContainingNamespace);
            default:
                // Unbound: the name is still a written fact — `using Newtonsoft.Json;`
                // says exactly which namespace the file wanted, so the stub is
                // named after the text, not after a guess.
                stats.NoteImport(resolved: false);
                var written = string.Concat(name.ToString().Where(c => !char.IsWhiteSpace(c)));
                if (written.StartsWith("global::", StringComparison.Ordinal)) written = written["global::".Length..];
                return written.Length == 0 || written.Contains('/') || written.Contains('#') ? null : NaturalKey.OfModule(written);
        }
    }

    // ---------------------------------------------------------- base lists --

    private void BaseList(Corpus corpus, INamedTypeSymbol type, List<Edge> edges)
    {
        if (type.TypeKind is TypeKind.Enum or TypeKind.Delegate) return;
        var from = Ids.Type(type)!;
        var parts = Syntax.DeclarationsOf(type);
        var partial = parts.Count > 1;
        foreach (var part in parts)
        {
            if (part is not BaseTypeDeclarationSyntax { BaseList: { } baseList }) continue;
            var model = corpus.Compilation.GetSemanticModel(part.SyntaxTree);
            foreach (var baseType in baseList.Types)
            {
                var symbol = model.GetTypeInfo(baseType.Type).Type as INamedTypeSymbol;
                stats.NoteTypeReference(resolved: symbol is not null && symbol.TypeKind != TypeKind.Error);
                var to = registry.Note(symbol);
                if (to is null) continue;
                // An interface only extends; anything else extends its BaseType
                // and implements the rest — Roslyn already made that split.
                var kind = type.TypeKind == TypeKind.Interface || SymbolEqualityComparer.Default.Equals(type.BaseType?.OriginalDefinition, symbol!.OriginalDefinition)
                    ? EdgeKinds.Inheritance
                    : EdgeKinds.InterfaceImplementation;
                Add(edges, new Edge(kind, from, to, Provenance.Declared, Syntax.AnchorOf(baseType))
                {
                    SourceFile = partial ? part.SyntaxTree.FilePath : null,
                });
            }
        }
    }

    // ----------------------------------------------------------------------

    private void Add(List<Edge> edges, Edge edge)
    {
        if (edge.From.Equals(edge.To)) { stats.SelfEdgesDropped++; return; }
        if (!seen.Add((edge.Kind, edge.From, edge.To, edge.Anchor.File, edge.Anchor.StartLine, edge.Anchor.EndLine, edge.Provenance))) return;
        edges.Add(edge);
    }
}
