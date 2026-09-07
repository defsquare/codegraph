using Codegraph.CSharp.Model;
using Microsoft.CodeAnalysis;

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
/// types, the types themselves, and (M12a) delegates with their parameters.
/// The kind → traits table below is the C# profile restated; the profile
/// validates it from the other side (packages/core/test/fixtures-csharp.test.ts).
/// </summary>
public sealed class EntityExtractor(CorpusWhitelist whitelist, TypeRegistry registry)
{
    public List<Entity> Extract(Corpus corpus, Progress progress) =>
        progress.Phase("entities", () =>
        {
            var entities = new List<Entity>();
            foreach (var ns in whitelist.Namespaces.Values) entities.Add(Namespace(ns));
            foreach (var type in whitelist.Types) entities.AddRange(Type(type));
            return entities;
        }, list => $"{list.Count:N0} entities");

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

    private IEnumerable<Entity> Type(INamedTypeSymbol type)
    {
        var key = Ids.Type(type) ?? throw new InvalidOperationException($"a declared type has no key: {type}");
        var declarations = Syntax.DeclarationsOf(type);
        var primary = declarations[0];
        var kind = KindOf(type);
        var entity = new Entity { Key = key, Kind = kind }.With(RequiredTraits(kind));
        entity.Name = type.Name;
        entity.IsStub = false;
        entity.Parent = type.ContainingType is { } outer
            ? Ids.Type(outer) ?? throw new InvalidOperationException($"nested in an anonymous type: {type}")
            : Ids.Namespace(type.ContainingNamespace);
        entity.Anchor = Syntax.AnchorOf(primary);
        var comments = Syntax.DocComments(declarations);
        if (comments.Count > 0) { entity.With(Traits.TComment); entity.Comments = comments; }

        if (type.TypeKind == TypeKind.Enum)
        {
            // `enum E : byte` — the underlying integral type is the enum's declared type.
            entity.With(Traits.TTypedEntity);
            entity.DeclaredType = registry.Note(type.EnumUnderlyingType);
        }
        yield return entity;

        if (type.TypeKind == TypeKind.Delegate)
        {
            var invoke = type.DelegateInvokeMethod ?? throw new InvalidOperationException($"delegate without Invoke: {type}");
            entity.Signature = Signatures.OfDelegate(type);
            entity.DeclaredType = invoke.ReturnsVoid ? null : registry.Note(invoke.ReturnType);
            entity.Parameters = [];
            foreach (var parameter in invoke.Parameters)
            {
                var p = Parameter(key, parameter);
                entity.Parameters.Add(p.Key);
                yield return p;
            }
        }
    }

    private Entity Parameter(NaturalKey owner, IParameterSymbol parameter)
    {
        var entity = new Entity { Key = Ids.Parameter(owner, parameter.Name), Kind = Kinds.Parameter }
            .With(Traits.TNamed, Traits.TStructural, Traits.TTypedEntity, Traits.TChildOf);
        entity.Name = parameter.Name;
        entity.Parent = owner;
        entity.DeclaredType = registry.Note(parameter.Type);
        var declaration = Syntax.PrimaryDeclaration(parameter);
        if (declaration is not null) { entity.With(Traits.TSourceAnchor); entity.Anchor = Syntax.AnchorOf(declaration); }
        return entity;
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

    /// <summary>The C# profile's required traits per type kind (packages/core/src/profiles/csharp.ts).</summary>
    public static string[] RequiredTraits(string kind) =>
        kind switch
        {
            Kinds.Class => [Traits.TNamed, Traits.TType, Traits.TWithInheritances, Traits.TWithImplements, Traits.TWithChildren, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Record => [Traits.TNamed, Traits.TType, Traits.TWithInheritances, Traits.TWithImplements, Traits.TWithChildren, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Interface => [Traits.TNamed, Traits.TType, Traits.TWithInheritances, Traits.TWithChildren, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Struct => [Traits.TNamed, Traits.TType, Traits.TWithImplements, Traits.TWithChildren, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Enum => [Traits.TNamed, Traits.TType, Traits.TWithChildren, Traits.TChildOf, Traits.TSourceAnchor],
            Kinds.Delegate => [Traits.TNamed, Traits.TType, Traits.TInvocable, Traits.TWithChildren, Traits.TWithParameters, Traits.TTypedEntity, Traits.TChildOf, Traits.TSourceAnchor],
            _ => throw new ArgumentException($"not a type kind: {kind}", nameof(kind)),
        };
}
