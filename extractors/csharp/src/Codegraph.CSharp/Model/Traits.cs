namespace Codegraph.CSharp.Model;

/// <summary>
/// The canonical trait vocabulary, in the order core declares it
/// (schemas/header.record.schema.json). An entity's trait list is emitted in
/// this order, so the same entity always produces the same bytes.
/// </summary>
public static class Traits
{
    public const string TNamed = "TNamed";
    public const string TSourceAnchor = "TSourceAnchor";
    public const string TComment = "TComment";
    public const string TWithChildren = "TWithChildren";
    public const string TChildOf = "TChildOf";
    public const string TAttachedTo = "TAttachedTo";
    public const string TModule = "TModule";
    public const string TType = "TType";
    public const string TWithInheritances = "TWithInheritances";
    public const string TWithImplements = "TWithImplements";
    public const string TTypedEntity = "TTypedEntity";
    public const string TInvocable = "TInvocable";
    public const string TWithParameters = "TWithParameters";
    public const string TWithLocalVariables = "TWithLocalVariables";
    public const string TWithInvocations = "TWithInvocations";
    public const string TStructural = "TStructural";
    public const string TWithAccesses = "TWithAccesses";
    public const string TMetrics = "TMetrics";
    public const string TWithValue = "TWithValue";

    public static readonly IReadOnlyList<string> Canonical =
    [
        TNamed, TSourceAnchor, TComment, TWithChildren, TChildOf, TAttachedTo, TModule, TType,
        TWithInheritances, TWithImplements, TTypedEntity, TInvocable, TWithParameters,
        TWithLocalVariables, TWithInvocations, TStructural, TWithAccesses, TMetrics, TWithValue,
    ];

    private static readonly Dictionary<string, int> RankOf =
        Canonical.Select((name, index) => (name, index)).ToDictionary(p => p.name, p => p.index, StringComparer.Ordinal);

    /// <summary>Orders trait names canonically; an unknown name is a bug, not data.</summary>
    public static readonly IComparer<string> Order = Comparer<string>.Create((a, b) => Rank(a).CompareTo(Rank(b)));

    public static int Rank(string trait) =>
        RankOf.TryGetValue(trait, out var rank)
            ? rank
            : throw new ArgumentException($"not a canonical trait: {trait}", nameof(trait));
}

/// <summary>Edge kinds this extractor emits — the C# profile's list.</summary>
public static class EdgeKinds
{
    public const string Import = "import";
    public const string Inheritance = "inheritance";
    public const string InterfaceImplementation = "interfaceImplementation";
    public const string Invocation = "invocation";
    public const string Access = "access";
    public const string Reference = "reference";
    public const string AnnotationUse = "annotationUse";
    public const string Throws = "throws";
}

public static class Provenance
{
    public const string Declared = "declared";
    public const string Derived = "derived";
    public const string DynamicCandidate = "dynamic-candidate";
    public const string Generated = "generated";
}

/// <summary>Entity kinds — the C# profile's kind names, restated here as literals.</summary>
public static class Kinds
{
    public const string Namespace = "namespace";
    public const string Class = "class";
    public const string Interface = "interface";
    public const string Struct = "struct";
    public const string Enum = "enum";
    public const string Record = "record";
    public const string Delegate = "delegate";
    public const string Method = "method";
    public const string Constructor = "constructor";
    public const string Property = "property";
    public const string Field = "field";
    public const string Event = "event";
    public const string Parameter = "parameter";
    public const string LocalVariable = "localVariable";
    public const string Lambda = "lambda";
}
