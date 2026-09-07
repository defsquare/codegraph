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
        // A C# 14 extension block's members belong to the enclosing static class.
        if (definition.IsExtension) return definition.ContainingType is { } host ? Type(host) : null;
        if (definition.TypeKind == TypeKind.Error)
        {
            // An error type with no name (`base.X` on an unresolved base) names
            // nothing a stub could carry — it must not collapse into the module key.
            var path = TypePath(definition);
            return path.Length == 0 || path.StartsWith('.') || path.EndsWith('.') ? null : new NaturalKey(NaturalKey.UnresolvedModule, path);
        }
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

    /// <summary>Below the owner's own disambiguator when it has one (a lambda's position, a local function's `fn:`), so two lambdas' `x` never collide.</summary>
    public static NaturalKey Parameter(NaturalKey owner, string name) =>
        new(owner.Module, owner.Symbol, owner.Disambiguator is null ? "param:" + name : owner.Disambiguator + "#param:" + name);
}

/// <summary>
/// Signatures for ids: fully-qualified metadata names WITH type arguments —
/// `System.Func`2<!!0,System.String>` — so overloads that differ only in a
/// namespace, an arity or a type argument get distinct keys. C# can overload
/// on type arguments alone (`Humanize(Func<T,string>)` beside
/// `Humanize(Func<T,object>)`, found on Humanizer), which Java's erasure could
/// not; erasing here would merge two written methods into one entity. What IS
/// erased: nullable annotations, `ref`/`out`/`in`, parameter names. Type
/// parameters are ECMA-335 ordinals (`!0` type-level, `!!0` method-level).
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
        // A generic method's arity is part of its signature, as a type's is of its symbol.
        if (method.Arity > 0) sb.Append('`').Append(method.Arity);
        AppendParameters(sb, method.Parameters);
        // Conversion operators overload on their RETURN type alone — 37 of them
        // on one OrchardCore type — so it is part of their signature and of no other's.
        if (method.MethodKind == MethodKind.Conversion) sb.Append(':').Append(Erased(method.ReturnType));
        return sb.ToString();
    }

    /// <summary>A delegate's signature is its `Invoke` method's, under the delegate's own name.</summary>
    public static string OfDelegate(INamedTypeSymbol type)
    {
        var sb = new StringBuilder(type.MetadataName);
        AppendParameters(sb, type.DelegateInvokeMethod?.Parameters ?? []);
        return sb.ToString();
    }

    /// <summary>`(T1,T2)` — a lambda's whole signature, an indexer's symbol suffix.</summary>
    public static string ParameterList(IEnumerable<IParameterSymbol> parameters)
    {
        var sb = new StringBuilder();
        AppendParameters(sb, parameters);
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
                var actual = named.TupleUnderlyingType ?? named;
                var definition = actual.OriginalDefinition;
                string head;
                if (definition.TypeKind == TypeKind.Error || definition.IsAnonymousType) head = Ids.TypePath(definition);
                else
                {
                    var ns = definition.ContainingNamespace;
                    var path = Ids.TypePath(definition);
                    head = ns.IsGlobalNamespace ? path : ns.ToDisplayString() + "." + path;
                }
                // Type arguments of the whole nesting chain, outermost first,
                // omitted when the type is its own definition (an open generic).
                var arguments = new List<string>();
                for (INamedTypeSymbol? t = actual; t is not null; t = t.ContainingType)
                    if (!t.IsUnboundGenericType) arguments.InsertRange(0, t.TypeArguments.Select(Erased));
                var isOpen = SymbolEqualityComparer.Default.Equals(actual, definition);
                return arguments.Count == 0 || isOpen ? head : head + "<" + string.Join(',', arguments) + ">";
            }
            default:
                return type.ToDisplayString();
        }
    }
}
