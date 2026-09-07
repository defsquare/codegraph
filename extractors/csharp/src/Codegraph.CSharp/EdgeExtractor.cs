using Codegraph.CSharp.Model;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Codegraph.CSharp;

/// <summary>
/// Pass 3 — relations, outgoing only, every one anchored: `import`,
/// `inheritance`, `interfaceImplementation`, `invocation`, `access`,
/// `reference`, `throws`, `annotationUse`. The SOURCE of an edge is the nearest
/// declared ancestor of the syntax that wrote it (a parameter's type reference
/// comes from the parameter, a field initializer's call from the field); the
/// TARGET is the member's entity, or its containing type when nothing was
/// emitted for the member (Declarations.TargetOf). A self-edge is not
/// representable and is dropped and counted; so is a `dynamic` call site.
/// </summary>
public sealed class EdgeExtractor(CorpusWhitelist whitelist, Declarations declarations, TypeRegistry registry, ResolutionStats stats)
{
    // Read and write are two facts: `n = 1; var x = n;` on one line is both.
    private readonly HashSet<(string, NaturalKey, NaturalKey, string, int, int, string, bool?, bool?)> seen = [];
    private SemanticModel model = null!;
    private List<Edge> edges = null!;

    public List<Edge> Extract(Corpus corpus, Progress progress) =>
        progress.Phase("edges", () =>
        {
            edges = [];
            foreach (var tree in corpus.Trees)
            {
                model = corpus.Compilation.GetSemanticModel(tree);
                Imports(tree);
                foreach (var node in tree.GetRoot().DescendantNodes()) Visit(node);
            }
            foreach (var type in whitelist.Types) BaseList(corpus, type);
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
    private void Imports(SyntaxTree tree)
    {
        foreach (var directive in tree.GetRoot().DescendantNodes().OfType<UsingDirectiveSyntax>())
        {
            var target = ImportTarget(directive);
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
                Add(new Edge(EdgeKinds.Import, NaturalKey.OfModule(from), target, Provenance.Declared, anchor));
        }
    }

    private NaturalKey? ImportTarget(UsingDirectiveSyntax directive)
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

    private void BaseList(Corpus corpus, INamedTypeSymbol type)
    {
        if (type.TypeKind is TypeKind.Enum or TypeKind.Delegate) return;
        var from = Ids.Type(type)!;
        var parts = Syntax.DeclarationsOf(type);
        var partial = parts.Count > 1;
        foreach (var part in parts)
        {
            if (part is not BaseTypeDeclarationSyntax { BaseList: { } baseList }) continue;
            var partModel = corpus.Compilation.GetSemanticModel(part.SyntaxTree);
            foreach (var baseType in baseList.Types)
            {
                var symbol = partModel.GetTypeInfo(baseType.Type).Type as INamedTypeSymbol;
                stats.NoteTypeReference(resolved: symbol is not null && symbol.TypeKind != TypeKind.Error);
                var to = registry.Note(symbol);
                if (to is null) continue;
                // An interface only extends; anything else extends its BaseType
                // and implements the rest — Roslyn already made that split.
                var kind = type.TypeKind == TypeKind.Interface || SymbolEqualityComparer.Default.Equals(type.BaseType?.OriginalDefinition, symbol!.OriginalDefinition)
                    ? EdgeKinds.Inheritance
                    : EdgeKinds.InterfaceImplementation;
                Add(new Edge(kind, from, to, Provenance.Declared, Syntax.AnchorOf(baseType))
                {
                    SourceFile = partial ? part.SyntaxTree.FilePath : null,
                });
            }
        }
    }

    // ------------------------------------------------------------- bodies --

    private void Visit(SyntaxNode node)
    {
        switch (node)
        {
            case InvocationExpressionSyntax invocation: Invocation(invocation); break;
            case BaseObjectCreationExpressionSyntax creation: Call(creation, creation); break;
            case ConstructorInitializerSyntax initializer: Call(initializer, initializer); break;
            case ElementAccessExpressionSyntax element: Access(element, element); break;
            case BinaryExpressionSyntax or PrefixUnaryExpressionSyntax or PostfixUnaryExpressionSyntax:
                if (model.GetSymbolInfo(node).Symbol is IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator or MethodKind.BuiltinOperator } op
                    && op.MethodKind == MethodKind.UserDefinedOperator)
                    Call(node, node, op);
                break;
            case SimpleNameSyntax name: Name(name); break;
            case PredefinedTypeSyntax predefined: Reference(predefined, model.GetTypeInfo(predefined).Type); break;
            case ThrowStatementSyntax { Expression: { } thrown }: Throws(node, thrown); break;
            case ThrowStatementSyntax rethrow: Rethrow(rethrow); break;
            case ThrowExpressionSyntax thrownExpression: Throws(node, thrownExpression.Expression); break;
            case AttributeSyntax attribute: Attribute(attribute); break;
        }
    }

    private void Invocation(InvocationExpressionSyntax invocation)
    {
        if (invocation.Expression is IdentifierNameSyntax { Identifier.Text: "nameof" } && model.GetSymbolInfo(invocation).Symbol is null)
            return; // nameof(x): a name, not a use
        var info = model.GetSymbolInfo(invocation);
        if (info.Symbol is IMethodSymbol method) { Call(invocation, invocation, method); return; }
        if (invocation.Expression is MemberAccessExpressionSyntax { Expression: { } receiver }
            && model.GetTypeInfo(receiver).Type is IDynamicTypeSymbol)
            stats.DynamicCallSitesDropped++;
        else
            stats.NoteTypeReference(resolved: false);
    }

    private void Call(SyntaxNode site, SyntaxNode anchor, IMethodSymbol? method = null)
    {
        method ??= model.GetSymbolInfo(site).Symbol as IMethodSymbol;
        if (method is null) { stats.NoteTypeReference(resolved: false); return; }
        var from = declarations.OwnerOf(site);
        if (from is null) return;
        var to = declarations.TargetOf(method, registry);
        if (to is null) return;
        stats.NoteTypeReference(resolved: method.ContainingType?.TypeKind != TypeKind.Error);
        Add(new Edge(EdgeKinds.Invocation, from, to, Provenance.Declared, Syntax.AnchorOf(anchor)));
    }

    /// <summary>
    /// Every simple name is one of: a member (→ access), a type (→ reference),
    /// a method group (→ reference to the method), or something that is not a
    /// dependency (a local, a parameter, a namespace, `var`).
    /// </summary>
    private void Name(SimpleNameSyntax name)
    {
        if (name is IdentifierNameSyntax { IsVar: true }) return;
        if (InExcludedContext(name)) return;
        var symbol = model.GetSymbolInfo(name).Symbol;
        switch (symbol)
        {
            case IFieldSymbol or IPropertySymbol or IEventSymbol:
                Access(name, name, symbol);
                break;
            case INamedTypeSymbol type:
                Reference(name, type);
                break;
            case IMethodSymbol method when name.Parent is not InvocationExpressionSyntax && !IsInvocationTarget(name):
                // A method group used as a value (`new Free(Zero)`, `handler += Log`).
                MethodGroup(name, method);
                break;
            case IAliasSymbol alias when alias.Target is INamedTypeSymbol aliased:
                Reference(name, aliased);
                break;
            case null:
                UnresolvedName(name);
                break;
        }
    }

    /// <summary>
    /// An unbound name becomes a reference to a stub in `&lt;unresolved&gt;` when it
    /// stands on its own or as the RECEIVER of a member access
    /// (`JsonConvert.SerializeObject(x)` depends on `JsonConvert`); a member of
    /// something unknown (`base.Post` on an unresolved base, `.SerializeObject`)
    /// adds nothing the receiver did not already say, and a dotted namespace
    /// prefix (`MegaCorp.Ledger.X`) names no type at all.
    /// </summary>
    private void UnresolvedName(SimpleNameSyntax name)
    {
        switch (name.Parent)
        {
            case MemberAccessExpressionSyntax m when m.Name == name:
            case MemberBindingExpressionSyntax:
            case QualifiedNameSyntax q when q.Left == name:
            case AliasQualifiedNameSyntax:
                return;
        }
        var type = model.GetTypeInfo(name).Type as INamedTypeSymbol
            ?? model.GetSymbolInfo(name).CandidateSymbols.OfType<INamedTypeSymbol>().FirstOrDefault();
        if (type is { TypeKind: TypeKind.Error, Name.Length: > 0 }) { Reference(name, type); return; }
        stats.NoteTypeReference(resolved: false);
        if (type is not null && type.TypeKind != TypeKind.Error) return;

        // In expression position Roslyn gives an unbound receiver no type at all
        // (`JsonConvert.SerializeObject(x)`), and none in a type position it could
        // not even guess. The written name is still the fact: a stub named after
        // it, in <unresolved>, exactly as the type-position case above produces.
        var isReceiver = name.Parent is MemberAccessExpressionSyntax { Expression: var receiver } && receiver == name;
        if (!isReceiver && !SyntaxFacts.IsInTypeOnlyContext(name)) return;
        var written = name.Identifier.Text + (name is GenericNameSyntax g ? "`" + g.TypeArgumentList.Arguments.Count : "");
        if (written.Length == 0 || written.Contains('#')) return;
        var from = declarations.OwnerOf(name);
        if (from is null) return;
        Add(new Edge(EdgeKinds.Reference, from, new NaturalKey(NaturalKey.UnresolvedModule, written), Provenance.Declared, Syntax.AnchorOf(name)));
    }

    private static bool InExcludedContext(SyntaxNode node)
    {
        for (var n = node.Parent; n is not null; n = n.Parent)
        {
            switch (n)
            {
                case UsingDirectiveSyntax:
                case BaseListSyntax:
                case NamespaceDeclarationSyntax when node.Ancestors().TakeWhile(a => a != n).All(a => a is NameSyntax):
                case FileScopedNamespaceDeclarationSyntax when node.Ancestors().TakeWhile(a => a != n).All(a => a is NameSyntax):
                    return true;
                case AttributeSyntax:
                    return true; // the name IS the annotationUse edge; the arguments ride on it as values
                case InvocationExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.Text: "nameof" } }:
                    return true;
                case MemberDeclarationSyntax or StatementSyntax or AnonymousFunctionExpressionSyntax:
                    return false;
            }
        }
        return false;
    }

    private static bool IsInvocationTarget(SimpleNameSyntax name) =>
        name.Parent is MemberAccessExpressionSyntax { Parent: InvocationExpressionSyntax } m && m.Name == name
        || name.Parent is MemberBindingExpressionSyntax { Parent: InvocationExpressionSyntax };

    private void Access(SyntaxNode site, SyntaxNode anchor, ISymbol? member = null)
    {
        member ??= model.GetSymbolInfo(site).Symbol;
        if (member is not (IFieldSymbol or IPropertySymbol or IEventSymbol)) { if (site is ElementAccessExpressionSyntax) stats.NoteTypeReference(resolved: false); return; }
        var from = declarations.OwnerOf(site);
        if (from is null) return;
        var to = declarations.TargetOf(member, registry);
        if (to is null) return;
        stats.NoteTypeReference(resolved: member.ContainingType?.TypeKind != TypeKind.Error);
        var (read, write) = ReadWrite(site);
        Add(new Edge(EdgeKinds.Access, from, to, Provenance.Declared, Syntax.AnchorOf(anchor)) { IsRead = read, IsWrite = write });
    }

    /// <summary>Written when the expression is an assignment target or `out` argument; read as well for compound forms.</summary>
    private static (bool Read, bool Write) ReadWrite(SyntaxNode site)
    {
        var expression = site;
        while (expression.Parent is MemberAccessExpressionSyntax m && m.Name == expression) expression = m;
        while (expression.Parent is ConditionalAccessExpressionSyntax c && c.WhenNotNull == expression) expression = c;
        if (expression.Parent is MemberBindingExpressionSyntax b) expression = b.Parent is ConditionalAccessExpressionSyntax ca ? ca : b;
        switch (expression.Parent)
        {
            case AssignmentExpressionSyntax assignment when assignment.Left == expression:
                return assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) ? (false, true) : (true, true);
            case PrefixUnaryExpressionSyntax prefix when prefix.IsKind(SyntaxKind.PreIncrementExpression) || prefix.IsKind(SyntaxKind.PreDecrementExpression):
            case PostfixUnaryExpressionSyntax:
                return (true, true);
            case ArgumentSyntax argument when argument.RefKindKeyword.IsKind(SyntaxKind.OutKeyword):
                return (false, true);
            case ArgumentSyntax argument when argument.RefKindKeyword.IsKind(SyntaxKind.RefKeyword):
                return (true, true);
            default:
                return (true, false);
        }
    }

    private void Reference(SyntaxNode site, ITypeSymbol? type)
    {
        if (type is { SpecialType: SpecialType.System_Void }) return; // `void` names no type
        var to = registry.Note(type);
        stats.NoteTypeReference(resolved: type is not null && type.TypeKind != TypeKind.Error && to is not null || type is ITypeParameterSymbol);
        if (to is null) return;
        var from = declarations.OwnerOf(site);
        if (from is null) return;
        Add(new Edge(EdgeKinds.Reference, from, to, Provenance.Declared, Syntax.AnchorOf(site)));
    }

    private void MethodGroup(SimpleNameSyntax name, IMethodSymbol method)
    {
        var from = declarations.OwnerOf(name);
        var to = declarations.TargetOf(method, registry);
        if (from is null || to is null) return;
        Add(new Edge(EdgeKinds.Reference, from, to, Provenance.Declared, Syntax.AnchorOf(name)));
    }

    private void Throws(SyntaxNode site, ExpressionSyntax thrown)
    {
        var type = model.GetTypeInfo(thrown).Type;
        var from = declarations.OwnerOf(site);
        var to = registry.Note(type);
        if (from is null || to is null) { stats.NoteTypeReference(resolved: false); return; }
        Add(new Edge(EdgeKinds.Throws, from, to, Provenance.Declared, Syntax.AnchorOf(site)));
    }

    /// <summary>`throw;` rethrows the enclosing catch's exception — its declared type, or nothing nameable.</summary>
    private void Rethrow(ThrowStatementSyntax rethrow)
    {
        var catchClause = rethrow.Ancestors().OfType<CatchClauseSyntax>().FirstOrDefault();
        var type = catchClause?.Declaration is { } declaration ? model.GetTypeInfo(declaration.Type).Type : null;
        var from = declarations.OwnerOf(rethrow);
        var to = registry.Note(type);
        if (from is null || to is null) { stats.NoteTypeReference(resolved: false); return; }
        Add(new Edge(EdgeKinds.Throws, from, to, Provenance.Declared, Syntax.AnchorOf(rethrow)));
    }

    /// <summary>
    /// An attribute is an `annotationUse` edge from the declaration it decorates
    /// to the attribute type, carrying its arguments as written values:
    /// positional ones named after the bound constructor's parameters, so the
    /// argument list is always named.
    /// </summary>
    private void Attribute(AttributeSyntax attribute)
    {
        var from = declarations.OwnerOf(attribute);
        if (from is null) return; // assembly/module-level: nothing declared to hang it on
        // An argument that does not bind (`LedgerClient.AuditTag`) fails overload
        // resolution; the candidate still names the parameters.
        var info = model.GetSymbolInfo(attribute);
        var ctor = info.Symbol as IMethodSymbol ?? info.CandidateSymbols.OfType<IMethodSymbol>().FirstOrDefault();
        var type = ctor?.ContainingType ?? model.GetTypeInfo(attribute).Type as INamedTypeSymbol;
        stats.NoteTypeReference(resolved: type is not null && type.TypeKind != TypeKind.Error);
        var to = registry.Note(type);
        if (to is null) return;

        var arguments = new List<NamedArgument>();
        var positional = 0;
        foreach (var argument in attribute.ArgumentList?.Arguments ?? [])
        {
            string name;
            if (argument.NameEquals is { } named) name = named.Name.Identifier.Text;
            else if (argument.NameColon is { } colon) name = colon.Name.Identifier.Text;
            else
            {
                name = ctor is not null && positional < ctor.Parameters.Length ? ctor.Parameters[positional].Name : $"arg{positional}";
                positional++;
            }
            arguments.Add(new NamedArgument(name, Literals.FromExpression(argument.Expression, model, registry)));
        }
        Add(new Edge(EdgeKinds.AnnotationUse, from, to, Provenance.Declared, Syntax.AnchorOf(attribute)) { Arguments = arguments });
    }

    // ----------------------------------------------------------------------

    private void Add(Edge edge)
    {
        if (edge.From.Equals(edge.To)) { stats.SelfEdgesDropped++; return; }
        if (!seen.Add((edge.Kind, edge.From, edge.To, edge.Anchor.File, edge.Anchor.StartLine, edge.Anchor.EndLine, edge.Provenance, edge.IsRead, edge.IsWrite))) return;
        edges.Add(edge);
    }
}
