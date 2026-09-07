namespace Codegraph.CSharp.Model;

/// <summary>
/// A written value (METAMODEL.md §1.6, the M10c tagged union): numbers as
/// canonical decimal text, enum values as type + simple name, unfoldable
/// expressions kept as `unevaluated` source. Ids inside a value obey closure.
/// </summary>
public abstract record Literal
{
    public sealed record String(string V) : Literal;
    public sealed record Number(string V) : Literal;
    public sealed record Boolean(bool V) : Literal;
    public sealed record Null : Literal;
    public sealed record Enum(NaturalKey Type, string Name) : Literal;
    public sealed record TypeValue(NaturalKey Target) : Literal;
    public sealed record Array(IReadOnlyList<Literal> Items) : Literal;
    public sealed record Annotation(NaturalKey Type, IReadOnlyList<NamedArgument> Arguments) : Literal;
    public sealed record Unevaluated(string Source) : Literal;

    public IEnumerable<NaturalKey> References()
    {
        switch (this)
        {
            case Enum e: yield return e.Type; break;
            case TypeValue t: yield return t.Target; break;
            case Array a:
                foreach (var item in a.Items) foreach (var k in item.References()) yield return k;
                break;
            case Annotation an:
                yield return an.Type;
                foreach (var argument in an.Arguments) foreach (var k in argument.Value.References()) yield return k;
                break;
        }
    }
}
