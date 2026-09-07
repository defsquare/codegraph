using System.Text;
using Codegraph.CSharp.Model;
using Microsoft.CodeAnalysis;

namespace Codegraph.CSharp;

/// <summary>
/// THE C# id scheme (PLAN.md §13.3). Every key in the model comes from here.
/// <code>
///   namespace       csharp:Acme.Order                 global: csharp:&lt;global&gt;
///   type            csharp:Acme.Order/OrderService    generic: Repository`1   nested: Outer.Inner
///   unresolved type csharp:&lt;unresolved&gt;/JsonConvert   (an error type, named as written)
///   method          csharp:Acme.Order/OrderService.Bill(Acme.Order.Order)
///   parameter       csharp:Acme.Order/Type.Sig#param:name
/// </code>
/// Arity rides in the symbol (Roslyn's metadata name) because `Foo`, `Foo&lt;T&gt;`
/// and `Foo&lt;T,U&gt;` legally coexist in one namespace. A stub's key has the same
/// shape as a declared type's, on purpose: membership is the whitelist, never
/// the key's shape.
/// </summary>
public static class Ids
{
    public static NaturalKey Namespace(INamespaceSymbol ns) => NaturalKey.OfModule(ModuleOf(ns));

    public static string ModuleOf(INamespaceSymbol ns) =>
        ns.IsGlobalNamespace ? NaturalKey.GlobalModule : ns.ToDisplayString();

    /// <summary>The key of a named type, or null for what is not an entity (anonymous types).</summary>
    public static NaturalKey? Type(INamedTypeSymbol type)
    {
        // A tuple without element names IS its ValueTuple; with names, the underlying one is.
        var definition = (type.TupleUnderlyingType ?? type).OriginalDefinition;
        if (definition.IsAnonymousType) return null;
        if (definition.TypeKind == TypeKind.Error)
            return new NaturalKey(NaturalKey.UnresolvedModule, TypePath(definition));
        return new NaturalKey(ModuleOf(definition.ContainingNamespace), TypePath(definition));
    }

    /// <summary>Any type expression → the named type it depends on (array element, pointee), or null.</summary>
    public static NaturalKey? TypeOf(ITypeSymbol? type) =>
        type switch
        {
            null => null,
            IArrayTypeSymbol array => TypeOf(array.ElementType),
            IPointerTypeSymbol pointer => TypeOf(pointer.PointedAtType),
            INamedTypeSymbol named => Type(named),
            // Type parameters, dynamic, function pointers: not entities.
            _ => null,
        };

    /// <summary>`Outer.Inner` in metadata names — `Repository`1`, never the display form.</summary>
    public static string TypePath(INamedTypeSymbol type)
    {
        var parts = new Stack<string>();
        for (INamedTypeSymbol? t = type; t is not null; t = t.ContainingType) parts.Push(t.MetadataName);
        return string.Join('.', parts);
    }

    /// <summary>The symbol of a member below its type: `Type.Member` or `Type.Member(params)`.</summary>
    public static NaturalKey Member(NaturalKey type, string memberSymbol) =>
        new(type.Module, type.Symbol + "." + memberSymbol);

    public static NaturalKey Parameter(NaturalKey owner, string name) =>
        new(owner.Module, owner.Symbol, "param:" + name);
}

/// <summary>
/// Signatures for ids: erased, fully-qualified metadata names, so overloads that
/// differ only in a namespace or an arity get distinct keys. Type parameters
/// are ECMA-335 ordinals (`!0` type-level, `!!0` method-level): a parameter's
/// NAME is not part of a C# signature.
/// </summary>
public static class Signatures
{
    public static string Of(IMethodSymbol method)
    {
        var sb = new StringBuilder();
        sb.Append(method.MethodKind switch
        {
            MethodKind.Constructor => "<init>",
            MethodKind.StaticConstructor => "<cctor>",
            _ => method.MetadataName,
        });
        AppendParameters(sb, method.Parameters);
        return sb.ToString();
    }

    /// <summary>A delegate's signature is its `Invoke` method's, under the delegate's own name.</summary>
    public static string OfDelegate(INamedTypeSymbol type)
    {
        var sb = new StringBuilder(type.MetadataName);
        AppendParameters(sb, type.DelegateInvokeMethod?.Parameters ?? []);
        return sb.ToString();
    }

    private static void AppendParameters(StringBuilder sb, IEnumerable<IParameterSymbol> parameters)
    {
        sb.Append('(');
        var first = true;
        foreach (var parameter in parameters)
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append(Erased(parameter.Type));
        }
        sb.Append(')');
    }

    public static string Erased(ITypeSymbol type)
    {
        switch (type)
        {
            case IArrayTypeSymbol array:
                return Erased(array.ElementType) + "[" + new string(',', array.Rank - 1) + "]";
            case IPointerTypeSymbol pointer:
                return Erased(pointer.PointedAtType) + "*";
            case ITypeParameterSymbol tp:
                return (tp.TypeParameterKind == TypeParameterKind.Method ? "!!" : "!") + tp.Ordinal;
            case IDynamicTypeSymbol:
                return "System.Object";
            case IFunctionPointerTypeSymbol:
                return "delegate*";
            case INamedTypeSymbol named:
            {
                var definition = (named.TupleUnderlyingType ?? named).OriginalDefinition;
                if (definition.TypeKind == TypeKind.Error || definition.IsAnonymousType) return Ids.TypePath(definition);
                var ns = definition.ContainingNamespace;
                var path = Ids.TypePath(definition);
                return ns.IsGlobalNamespace ? path : ns.ToDisplayString() + "." + path;
            }
            default:
                return type.ToDisplayString();
        }
    }
}
