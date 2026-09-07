using System.Globalization;
using Codegraph.CSharp.Model;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Codegraph.CSharp;

/// <summary>
/// Written values → Literal (METAMODEL.md §1.6, the M10c shapes): what the
/// compiler folds is written folded, as canonical decimal text for numbers;
/// an enum value is its type plus the member's simple name; `typeof(T)` a type
/// reference; an array its items; anything the binder cannot fold stays as
/// `unevaluated` source — degraded honesty, never a dropped fact.
/// </summary>
public static class Literals
{
    public static Literal FromConstant(object? value, ITypeSymbol? type, TypeRegistry registry)
    {
        if (value is null) return new Literal.Null();
        if (type is INamedTypeSymbol { TypeKind: TypeKind.Enum } enumType)
        {
            var member = enumType.GetMembers().OfType<IFieldSymbol>()
                .FirstOrDefault(f => f.HasConstantValue && Equals(f.ConstantValue, value));
            var key = registry.Note(enumType);
            if (member is not null && key is not null) return new Literal.Enum(key, member.Name);
        }
        return value switch
        {
            string s => new Literal.String(s),
            bool b => new Literal.Boolean(b),
            char c => new Literal.String(c.ToString()),
            byte or sbyte or short or ushort or int or uint or long or ulong => new Literal.Number(Convert.ToString(value, CultureInfo.InvariantCulture)!),
            float f => new Literal.Number(Decimal(f)),
            double d => new Literal.Number(Decimal(d)),
            decimal m => new Literal.Number(m.ToString(CultureInfo.InvariantCulture).TrimEnd('0').TrimEnd('.')),
            _ => new Literal.Unevaluated(value.ToString() ?? ""),
        };
    }

    /// <summary>JavaScript's canonical form for a double: integral values without a fraction, else shortest round-trip.</summary>
    private static string Decimal(double d)
    {
        if (double.IsNaN(d)) return "NaN";
        if (double.IsPositiveInfinity(d)) return "Infinity";
        if (double.IsNegativeInfinity(d)) return "-Infinity";
        if (Math.Floor(d) == d && Math.Abs(d) < 1e21) return ((long)d).ToString(CultureInfo.InvariantCulture);
        var text = d.ToString("R", CultureInfo.InvariantCulture);
        return text.Replace("E+", "e", StringComparison.Ordinal).Replace("E-", "e-", StringComparison.Ordinal).Replace("E", "e", StringComparison.Ordinal);
    }

    /// <summary>An attribute argument or initializer expression as written.</summary>
    public static Literal FromExpression(ExpressionSyntax expression, SemanticModel model, TypeRegistry registry)
    {
        switch (expression)
        {
            case TypeOfExpressionSyntax typeOf:
            {
                var key = registry.Note(model.GetTypeInfo(typeOf.Type).Type);
                return key is null ? new Literal.Unevaluated(Source(expression)) : new Literal.TypeValue(key);
            }
            case ArrayCreationExpressionSyntax { Initializer: { } init }:
                return new Literal.Array(init.Expressions.Select(e => FromExpression(e, model, registry)).ToList());
            case ImplicitArrayCreationExpressionSyntax implicitArray:
                return new Literal.Array(implicitArray.Initializer.Expressions.Select(e => FromExpression(e, model, registry)).ToList());
            case CollectionExpressionSyntax collection:
                return new Literal.Array(collection.Elements.OfType<ExpressionElementSyntax>().Select(e => FromExpression(e.Expression, model, registry)).ToList());
            case ParenthesizedExpressionSyntax parenthesized:
                return FromExpression(parenthesized.Expression, model, registry);
        }
        var constant = model.GetConstantValue(expression);
        if (constant.HasValue)
        {
            var type = model.GetTypeInfo(expression).Type;
            // A lone enum member keeps its name; an expression over enum values
            // (`A | B`) folds to a number only if no single member equals it.
            if (model.GetSymbolInfo(expression).Symbol is IFieldSymbol { ContainingType.TypeKind: TypeKind.Enum } member
                && registry.Note(member.ContainingType) is { } enumKey)
                return new Literal.Enum(enumKey, member.Name);
            return FromConstant(constant.Value, type, registry);
        }
        return new Literal.Unevaluated(Source(expression));
    }

    private static string Source(SyntaxNode node) => node.WithoutTrivia().ToString();
}
