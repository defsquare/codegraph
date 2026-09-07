using Codegraph.CSharp.Model;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Codegraph.CSharp;

/// <summary>
/// Non-corpus type symbols seen while producing keys, so pass 4 can synthesize
/// each stub with its real kind and simple name rather than guessing from the key.
/// </summary>
public sealed class TypeRegistry
{
    private readonly Dictionary<NaturalKey, INamedTypeSymbol> seen = [];

    public NaturalKey? Note(ITypeSymbol? type)
    {
        var key = Ids.TypeOf(type);
        if (key is null) return null;
        var named = Unwrap(type!);
        if (named is not null) seen.TryAdd(key, named);
        return key;
    }

    public INamedTypeSymbol? SymbolOf(NaturalKey key) => seen.GetValueOrDefault(key);

    private static INamedTypeSymbol? Unwrap(ITypeSymbol type) =>
        type switch
        {
            IArrayTypeSymbol a => Unwrap(a.ElementType),
            IPointerTypeSymbol p => Unwrap(p.PointedAtType),
            INamedTypeSymbol n => (n.TupleUnderlyingType ?? n).OriginalDefinition,
            _ => null,
        };
}

/// <summary>
/// Pass 2 — nodes for declared constructs only: namespaces holding corpus
/// types, the types, their members, parameters, locals, lambdas and local
/// functions. The kind → traits table below is the C# profile restated; the
/// profile validates it from the other side (packages/core/test/fixtures-csharp.test.ts).
///
/// What is NOT an entity, on purpose: a member Roslyn synthesizes and nobody
/// wrote (a record's `Equals`/`Deconstruct`/copy constructor, a backing field,
/// an enum's `value__`), an accessor (its body charges to the property), a
/// type parameter. The one implicit member emitted is the parameterless
/// constructor, so `new Basket()` does not dangle — anchored at the type's
/// header line, since it has no line of its own.
/// </summary>
public sealed class EntityExtractor(CorpusWhitelist whitelist, TypeRegistry registry)
{
    private readonly Declarations declarations = new();
    private SemanticModel? model;

    public Declarations Extract(Corpus corpus, Progress progress) =>
        progress.Phase("entities", () =>
        {
            foreach (var ns in whitelist.Namespaces.Values) declarations.Declare(Namespace(ns), ns.Symbol);
            foreach (var type in whitelist.Types) Type(corpus, type);
            return declarations;
        }, d => $"{d.Entities.Count:N0} entities");

    // ----------------------------------------------------------- namespaces --

    private static Entity Namespace(CorpusNamespace ns)
    {
        var entity = new Entity { Key = NaturalKey.OfModule(ns.Module), Kind = Kinds.Namespace }
            .With(Traits.TNamed, Traits.TModule, Traits.TWithChildren);
        entity.Name = ns.Module;
        entity.DefinedIn = ns.Files.ToList();
        entity.IsStub = false;
        if (ns.ParentModule is not null)
        {
            entity.With(Traits.TChildOf);
            entity.Parent = NaturalKey.OfModule(ns.ParentModule);
        }
        return entity;
    }

    // ---------------------------------------------------------------- types --

    private void Type(Corpus corpus, INamedTypeSymbol type)
    {
        var key = Ids.Type(type) ?? throw new InvalidOperationException($"a declared type has no key: {type}");
        var parts = Syntax.DeclarationsOf(type);
        var primary = parts[0];
        var kind = KindOf(type);
        var entity = new Entity { Key = key, Kind = kind }.With(RequiredTraits(kind));
        entity.Name = type.Name;
        entity.IsStub = false;
        entity.Parent = type.ContainingType is { } outer
            ? Ids.Type(outer) ?? throw new InvalidOperationException($"nested in an anonymous type: {type}")
            : Ids.Namespace(type.ContainingNamespace);
        entity.Anchor = Syntax.AnchorOf(primary);
        Comment(entity, parts);
        entity.With(Traits.TMetrics);
        entity.Metrics = new SortedDictionary<string, double>(StringComparer.Ordinal) { ["sloc"] = Measures.Sloc(primary) };

        if (type.TypeKind == TypeKind.Enum)
        {
            entity.With(Traits.TTypedEntity);
            entity.DeclaredType = registry.Note(type.EnumUnderlyingType);
        }
        declarations.Declare(entity, type, parts.ToArray());

        if (type.TypeKind == TypeKind.Delegate)
        {
            var invoke = type.DelegateInvokeMethod ?? throw new InvalidOperationException($"delegate without Invoke: {type}");
            entity.Signature = Signatures.OfDelegate(type);
            entity.DeclaredType = invoke.ReturnsVoid ? null : registry.Note(invoke.ReturnType);
            entity.Parameters = Parameters(key, invoke.Parameters);
            return;
        }

        Members(corpus, key, type, primary, type);
        // C# 14 extension blocks (`extension(Money m) { … }`, found on Humanizer):
        // Roslyn models each as a nameless nested type. It is no type the source
        // names, so its members are members of the enclosing static class —
        // like classic extension methods — attached to the receiver type.
        foreach (var block in type.GetTypeMembers().Where(t => t.IsExtension))
            Members(corpus, key, type, primary, block, block.ExtensionParameter?.Type);
    }

    private void Members(Corpus corpus, NaturalKey typeKey, INamedTypeSymbol type, SyntaxNode typePrimary, INamedTypeSymbol holder, ITypeSymbol? attachedTo = null)
    {
        foreach (var member in holder.GetMembers())
        {
            switch (member)
            {
                case IMethodSymbol method: Method(corpus, typeKey, type, typePrimary, method, attachedTo); break;
                case IPropertySymbol property: Property(corpus, typeKey, property, attachedTo); break;
                case IFieldSymbol field: Field(corpus, typeKey, field); break;
                case IEventSymbol evt: Event(corpus, typeKey, evt); break;
            }
        }
    }

    // -------------------------------------------------------------- members --

    private void Method(Corpus corpus, NaturalKey typeKey, INamedTypeSymbol type, SyntaxNode typePrimary, IMethodSymbol method, ITypeSymbol? attachedTo = null)
    {
        switch (method.MethodKind)
        {
            case MethodKind.Ordinary:
            case MethodKind.Constructor:
            case MethodKind.StaticConstructor:
            case MethodKind.UserDefinedOperator:
            case MethodKind.Conversion:
            case MethodKind.Destructor:
            case MethodKind.ExplicitInterfaceImplementation:
                break;
            default:
                return; // accessors, delegate Invoke, local/anonymous functions: not members here
        }
        var implicitDefaultCtor = method.IsImplicitlyDeclared && method.MethodKind == MethodKind.Constructor && method.Parameters.Length == 0 && !type.IsStatic;
        if (method.IsImplicitlyDeclared && !implicitDefaultCtor) return;

        var isCtor = method.MethodKind is MethodKind.Constructor or MethodKind.StaticConstructor;
        var kind = isCtor ? Kinds.Constructor : Kinds.Method;
        var key = Ids.Member(typeKey, Signatures.Of(method));
        var entity = new Entity { Key = key, Kind = kind }.With(RequiredTraits(kind));
        entity.Parent = typeKey;
        entity.Signature = Signatures.Of(method);

        var parts = Syntax.DeclarationsOf(method);
        if (method.PartialImplementationPart is { } impl) parts = [.. parts, .. Syntax.DeclarationsOf(impl)];
        parts = parts.OrderBy(n => n.SyntaxTree.FilePath, StringComparer.Ordinal).ThenBy(n => n.SpanStart).ToList();

        // A primary constructor is declared by the type's parameter list.
        var anchorNode = parts.FirstOrDefault() switch
        {
            TypeDeclarationSyntax typeDecl => (SyntaxNode?)typeDecl.ParameterList ?? typeDecl,
            var n => n,
        };
        if (anchorNode is null)
        {
            var header = Syntax.AnchorOf(typePrimary);
            entity.Anchor = new SourceAnchor(header.File, header.StartLine, header.StartLine);
            entity.Metrics = new SortedDictionary<string, double>(StringComparer.Ordinal) { ["sloc"] = 0, ["cyclomatic"] = 1 };
        }
        else
        {
            entity.Anchor = Syntax.AnchorOf(anchorNode);
            var body = parts.FirstOrDefault(p => p is not TypeDeclarationSyntax);
            entity.Metrics = new SortedDictionary<string, double>(StringComparer.Ordinal)
            {
                ["sloc"] = Measures.Sloc(anchorNode),
                ["cyclomatic"] = body is null ? 1 : Measures.Cyclomatic(body),
            };
        }
        entity.With(Traits.TMetrics);
        if (!isCtor)
        {
            entity.Name = method.Name;
            entity.DeclaredType = method.ReturnsVoid ? null : registry.Note(method.ReturnType);
        }
        var receiver = attachedTo ?? (method.IsExtensionMethod ? method.Parameters[0].Type : null);
        if (registry.Note(receiver) is { } extended)
        {
            entity.With(Traits.TAttachedTo);
            entity.AttachedTo = extended;
        }
        Comment(entity, parts.Where(p => p is not TypeDeclarationSyntax));
        key = declarations.Declare(entity, method, [.. parts.Where(p => p is not TypeDeclarationSyntax), anchorNode is ParameterListSyntax ? anchorNode : null]);
        entity.Parameters = Parameters(key, method.Parameters);
        entity.LocalVariables = [];
        foreach (var part in parts.Where(p => p is not TypeDeclarationSyntax)) Body(corpus, part, key, entity);
    }

    private void Property(Corpus corpus, NaturalKey typeKey, IPropertySymbol property, ITypeSymbol? attachedTo = null)
    {
        var parts = Syntax.DeclarationsOf(property);
        if (parts.Count == 0) return; // synthesized
        var symbol = property.IsIndexer ? "Item" + Signatures.ParameterList(property.Parameters) : property.MetadataName;
        var key = Ids.Member(typeKey, symbol);
        var entity = new Entity { Key = key, Kind = Kinds.Property }.With(RequiredTraits(Kinds.Property));
        entity.Name = property.Name;
        entity.Parent = typeKey;
        entity.DeclaredType = registry.Note(property.Type);
        if (registry.Note(attachedTo) is { } extended)
        {
            entity.With(Traits.TAttachedTo); // an extension property: written in the block, belonging to the receiver
            entity.AttachedTo = extended;
        }
        entity.Anchor = Syntax.AnchorOf(parts[0]);
        Comment(entity, parts);
        var hasBody = parts.Any(p => p.DescendantNodes().Any(n => n is BlockSyntax or ArrowExpressionClauseSyntax));
        if (hasBody) entity.With(Traits.TWithInvocations, Traits.TWithAccesses);
        entity.With(Traits.TMetrics);
        entity.Metrics = new SortedDictionary<string, double>(StringComparer.Ordinal)
        {
            ["sloc"] = parts.Sum(Measures.Sloc),
            ["cyclomatic"] = parts.Sum(p => Measures.Cyclomatic(p)) - (parts.Count - 1),
        };
        key = declarations.Declare(entity, property, parts.ToArray());
        // The profile gives a property no TWithLocalVariables: accessor locals
        // are its children (parent) but are not listed on it.
        if (property.IsIndexer) Parameters(key, property.Parameters);
        foreach (var part in parts) if (part is not ParameterSyntax) Body(corpus, part, key, entity);
    }

    private void Field(Corpus corpus, NaturalKey typeKey, IFieldSymbol field)
    {
        if (field.IsImplicitlyDeclared) return;
        var parts = Syntax.DeclarationsOf(field);
        if (parts.Count == 0) return;
        var key = Ids.Member(typeKey, field.MetadataName);
        var entity = new Entity { Key = key, Kind = Kinds.Field }.With(RequiredTraits(Kinds.Field));
        entity.Name = field.Name;
        entity.Parent = typeKey;
        entity.DeclaredType = registry.Note(field.Type);
        entity.Anchor = Syntax.AnchorOf(parts[0]);
        Comment(entity, parts);
        if (field.HasConstantValue)
        {
            // An enum MEMBER's value is its integral constant, not itself; a
            // const of an enum type elsewhere keeps the member form.
            var valueType = field.ContainingType.TypeKind == TypeKind.Enum ? field.ContainingType.EnumUnderlyingType : field.Type;
            entity.With(Traits.TWithValue);
            entity.Value = Literals.FromConstant(field.ConstantValue, valueType, registry);
        }
        // The field's declaration statement owns the attribute list; the
        // declarator owns the initializer. Both resolve to this entity.
        var statements = parts.Select(p => p.Parent?.Parent).Where(p => p is FieldDeclarationSyntax).ToArray();
        key = declarations.Declare(entity, field, [.. parts, .. statements]);
        foreach (var part in parts) Body(corpus, part, key, null);
    }

    private void Event(Corpus corpus, NaturalKey typeKey, IEventSymbol evt)
    {
        if (evt.IsImplicitlyDeclared) return;
        var parts = Syntax.DeclarationsOf(evt);
        if (parts.Count == 0) return;
        var key = Ids.Member(typeKey, evt.MetadataName);
        var entity = new Entity { Key = key, Kind = Kinds.Event }.With(RequiredTraits(Kinds.Event));
        entity.Name = evt.Name;
        entity.Parent = typeKey;
        entity.DeclaredType = registry.Note(evt.Type);
        entity.Anchor = Syntax.AnchorOf(parts[0]);
        Comment(entity, parts);
        var statements = parts.Select(p => p.Parent?.Parent).Where(p => p is EventFieldDeclarationSyntax).ToArray();
        key = declarations.Declare(entity, evt, [.. parts, .. statements]);
        foreach (var part in parts) Body(corpus, part, key, null);
    }

    private List<NaturalKey> Parameters(NaturalKey owner, IEnumerable<IParameterSymbol> parameters)
    {
        var keys = new List<NaturalKey>();
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var parameter in parameters)
        {
            // Discards repeat a name (`(_, _) => …`, found on OrchardCore): the
            // second and later same-named parameters carry their ordinal.
            var key = Ids.Parameter(owner, names.Add(parameter.Name) ? parameter.Name : parameter.Name + ":" + parameter.Ordinal);
            var entity = new Entity { Key = key, Kind = Kinds.Parameter }
                .With(Traits.TNamed, Traits.TStructural, Traits.TTypedEntity, Traits.TChildOf);
            entity.Name = parameter.Name;
            entity.Parent = owner;
            entity.DeclaredType = registry.Note(parameter.Type);
            var declaration = Syntax.PrimaryDeclaration(parameter);
            if (declaration is not null) { entity.With(Traits.TSourceAnchor); entity.Anchor = Syntax.AnchorOf(declaration); }
            if (parameter.HasExplicitDefaultValue)
            {
                entity.With(Traits.TWithValue);
                entity.Value = Literals.FromConstant(parameter.ExplicitDefaultValue, parameter.Type, registry);
            }
            declarations.Declare(entity, parameter, declaration);
            keys.Add(key);
        }
        return keys;
    }

    // --------------------------------------------------------------- bodies --

    /// <summary>
    /// Locals, lambdas and local functions below a declaration, each parented
    /// by the nearest enclosing invocable (or the property whose accessor holds
    /// it). A lambda in a field initializer has no invocable to belong to and is
    /// parented by the type, as the Java extractor does.
    /// </summary>
    private void Body(Corpus corpus, SyntaxNode root, NaturalKey owner, Entity? ownerEntity)
    {
        model = corpus.Compilation.GetSemanticModel(root.SyntaxTree);
        foreach (var child in root.ChildNodes()) Walk(child, owner, ownerEntity);
    }

    private void Walk(SyntaxNode node, NaturalKey owner, Entity? ownerEntity)
    {
        switch (node)
        {
            case AnonymousFunctionExpressionSyntax lambda:
                Lambda(lambda, owner, ownerEntity);
                return;
            case LocalFunctionStatementSyntax local:
                LocalFunction(local, owner);
                return;
            case VariableDeclaratorSyntax declarator when declarator.Parent?.Parent is LocalDeclarationStatementSyntax or ForStatementSyntax or UsingStatementSyntax or FixedStatementSyntax:
                Local(declarator, declarator.Identifier, owner, ownerEntity);
                break;
            case ForEachStatementSyntax forEach:
                Local(forEach, forEach.Identifier, owner, ownerEntity);
                break;
            case CatchDeclarationSyntax { Identifier.Text.Length: > 0 } catchDecl:
                Local(catchDecl, catchDecl.Identifier, owner, ownerEntity);
                break;
            case SingleVariableDesignationSyntax designation:
                Local(designation, designation.Identifier, owner, ownerEntity);
                break;
        }
        foreach (var child in node.ChildNodes()) Walk(child, owner, ownerEntity);
    }

    private void Local(SyntaxNode node, SyntaxToken identifier, NaturalKey owner, Entity? ownerEntity)
    {
        if (model!.GetDeclaredSymbol(node) is not ILocalSymbol local) return;
        var position = node.SyntaxTree.GetLineSpan(identifier.Span).StartLinePosition;
        var key = Sub(owner, $"local:{local.Name}:{position.Line + 1}:{position.Character + 1}");
        var entity = new Entity { Key = key, Kind = Kinds.LocalVariable }
            .With(Traits.TNamed, Traits.TStructural, Traits.TTypedEntity, Traits.TChildOf, Traits.TSourceAnchor);
        entity.Name = local.Name;
        entity.Parent = owner;
        entity.DeclaredType = registry.Note(local.Type);
        entity.Anchor = Syntax.AnchorOf(identifier);
        // Not registered as an owner: a foreach statement's node holds its whole
        // body, and an initializer's call is the invocable's dependency, not the
        // local's. The local's own type rides on declaredType.
        declarations.Declare(entity, local);
        ownerEntity?.LocalVariables?.Add(key);
    }

    private void Lambda(AnonymousFunctionExpressionSyntax lambda, NaturalKey owner, Entity? ownerEntity)
    {
        if (model!.GetSymbolInfo(lambda).Symbol is not IMethodSymbol symbol) return;
        // A lambda's symbol is the TYPE it is written in; its position is the identity.
        var typeKey = new NaturalKey(owner.Module, TypeSymbolOf(owner));
        var key = new NaturalKey(typeKey.Module, typeKey.Symbol, Syntax.LineColumn(lambda));
        var entity = new Entity { Key = key, Kind = Kinds.Lambda }.With(RequiredTraits(Kinds.Lambda));
        entity.Parent = ownerEntity is null ? typeKey : owner;
        entity.Anchor = Syntax.AnchorOf(lambda);
        entity.Signature = Signatures.ParameterList(symbol.Parameters);
        entity.With(Traits.TTypedEntity);
        entity.DeclaredType = symbol.ReturnsVoid ? null : registry.Note(symbol.ReturnType);
        entity.With(Traits.TMetrics);
        entity.Metrics = new SortedDictionary<string, double>(StringComparer.Ordinal)
        {
            ["sloc"] = Measures.Sloc(lambda),
            ["cyclomatic"] = Measures.Cyclomatic(lambda),
        };
        key = declarations.Declare(entity, symbol, lambda);
        entity.Parameters = Parameters(key, symbol.Parameters);
        entity.LocalVariables = [];
        foreach (var child in lambda.ChildNodes()) Walk(child, key, entity);
    }

    private void LocalFunction(LocalFunctionStatementSyntax local, NaturalKey owner)
    {
        if (model!.GetDeclaredSymbol(local) is not IMethodSymbol symbol) return;
        var key = Sub(owner, "fn:" + Signatures.Of(symbol));
        var entity = new Entity { Key = key, Kind = Kinds.Method }.With(RequiredTraits(Kinds.Method));
        entity.Name = symbol.Name;
        entity.Parent = owner;
        entity.Signature = Signatures.Of(symbol);
        entity.DeclaredType = symbol.ReturnsVoid ? null : registry.Note(symbol.ReturnType);
        entity.Anchor = Syntax.AnchorOf(local);
        Comment(entity, [local]);
        entity.With(Traits.TMetrics);
        entity.Metrics = new SortedDictionary<string, double>(StringComparer.Ordinal)
        {
            ["sloc"] = Measures.Sloc(local),
            ["cyclomatic"] = Measures.Cyclomatic(local),
        };
        key = declarations.Declare(entity, symbol, local);
        entity.Parameters = Parameters(key, symbol.Parameters);
        entity.LocalVariables = [];
        foreach (var child in local.ChildNodes()) Walk(child, key, entity);
    }

    /// <summary>A key below `owner`: the same symbol, the owner's disambiguator (if any) extended.</summary>
    private static NaturalKey Sub(NaturalKey owner, string tail) =>
        new(owner.Module, owner.Symbol, owner.Disambiguator is null ? tail : owner.Disambiguator + "#" + tail);

    /// <summary>The type symbol an owner key sits in: everything up to the member's `.name` or `(`.</summary>
    private string TypeSymbolOf(NaturalKey owner)
    {
        // Owners are types (symbol is the type path), members (`Type.member(...)`),
        // or lambdas (symbol already the type). A member's type is the longest
        // declared type-key prefix — cut BEFORE the parameter list, whose
        // fully-qualified types carry dots of their own.
        var paren = owner.Symbol.IndexOf('(');
        var symbol = paren < 0 ? owner.Symbol : owner.Symbol[..paren];
        while (true)
        {
            if (declarations.TypeKeys.Contains(new NaturalKey(owner.Module, symbol))) return symbol;
            var cut = symbol.LastIndexOf('.');
            if (cut < 0) throw new InvalidOperationException($"no declared type above {owner}");
            symbol = symbol[..cut];
        }
    }

    // ---------------------------------------------------------------- tables --

    private static void Comment(Entity entity, IEnumerable<SyntaxNode> parts)
    {
        var comments = Syntax.DocComments(parts);
        if (comments.Count > 0) { entity.With(Traits.TComment); entity.Comments = comments; }
    }

    public static string KindOf(INamedTypeSymbol type) =>
        type.TypeKind switch
        {
            TypeKind.Interface => Kinds.Interface,
            TypeKind.Enum => Kinds.Enum,
            TypeKind.Delegate => Kinds.Delegate,
            TypeKind.Struct => type.IsRecord ? Kinds.Record : Kinds.Struct,
            _ => type.IsRecord ? Kinds.Record : Kinds.Class,
        };

    /// <summary>The C# profile's required traits per kind (packages/core/src/profiles/csharp.ts).</summary>
    public static string[] RequiredTraits(string kind) =>
        kind switch
        {
            Kinds.Class => [Traits.TNamed, Traits.TType, Traits.TWithInheritances, Traits.TWithImplements, Traits.TWithChildren, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Record => [Traits.TNamed, Traits.TType, Traits.TWithInheritances, Traits.TWithImplements, Traits.TWithChildren, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Interface => [Traits.TNamed, Traits.TType, Traits.TWithInheritances, Traits.TWithChildren, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Struct => [Traits.TNamed, Traits.TType, Traits.TWithImplements, Traits.TWithChildren, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Enum => [Traits.TNamed, Traits.TType, Traits.TWithChildren, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Delegate => [Traits.TNamed, Traits.TType, Traits.TInvocable, Traits.TWithChildren, Traits.TWithParameters, Traits.TTypedEntity, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Method => [Traits.TNamed, Traits.TInvocable, Traits.TWithChildren, Traits.TWithParameters, Traits.TWithLocalVariables, Traits.TWithInvocations, Traits.TWithAccesses, Traits.TTypedEntity, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Constructor => [Traits.TInvocable, Traits.TWithChildren, Traits.TWithParameters, Traits.TWithLocalVariables, Traits.TWithInvocations, Traits.TWithAccesses, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Property => [Traits.TNamed, Traits.TStructural, Traits.TTypedEntity, Traits.TWithChildren, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Field => [Traits.TNamed, Traits.TStructural, Traits.TTypedEntity, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Event => [Traits.TNamed, Traits.TStructural, Traits.TTypedEntity, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Lambda => [Traits.TInvocable, Traits.TWithChildren, Traits.TWithParameters, Traits.TWithLocalVariables, Traits.TWithInvocations, Traits.TWithAccesses, Traits.TChildOf, Traits.TSourceAnchor],
            _ => throw new ArgumentException($"no trait table for kind: {kind}", nameof(kind)),
        };
}
