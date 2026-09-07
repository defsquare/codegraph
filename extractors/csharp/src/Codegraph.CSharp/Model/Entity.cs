namespace Codegraph.CSharp.Model;

/// <summary>Evidence: a root-relative file and a 1-based inclusive line span.</summary>
public sealed record SourceAnchor(string File, int StartLine, int EndLine)
{
    public SourceAnchor Validate()
    {
        if (File.Length == 0 || File.StartsWith('/')) throw new InvalidOperationException($"anchor file must be root-relative: {File}");
        if (StartLine < 1 || EndLine < StartLine) throw new InvalidOperationException($"anchor span must be 1-based and ordered: {File}:{StartLine}-{EndLine}");
        return this;
    }
}

/// <summary>
/// One entity: a natural key, a kind, a trait set, and the keys those traits
/// contribute. The trait/key table is the contract's §4, enforced by
/// <see cref="Validate"/> so a composition the extractor did not mean cannot
/// reach the file.
/// </summary>
public sealed class Entity
{
    public required NaturalKey Key { get; init; }
    public required string Kind { get; init; }
    public SortedSet<string> Traits { get; } = new(Model.Traits.Order);

    public string? Name { get; set; }
    public string? Signature { get; set; }
    public NaturalKey? DeclaredType { get; set; }
    public bool? IsStub { get; set; }
    public NaturalKey? Parent { get; set; }
    public NaturalKey? AttachedTo { get; set; }
    public List<NaturalKey>? Parameters { get; set; }
    public List<NaturalKey>? LocalVariables { get; set; }
    public List<string>? DefinedIn { get; set; }
    public List<string>? Comments { get; set; }
    public SortedDictionary<string, double>? Metrics { get; set; }
    public Literal? Value { get; set; }
    public SourceAnchor? Anchor { get; set; }

    public Entity With(params string[] traits)
    {
        foreach (var trait in traits) Traits.Add(trait);
        return this;
    }

    public bool Has(string trait) => Traits.Contains(trait);

    /// <summary>Every referenced key, for closure: parent, attachedTo, declaredType, parameters, locals, values.</summary>
    public IEnumerable<NaturalKey> References()
    {
        if (Parent is not null) yield return Parent;
        if (AttachedTo is not null) yield return AttachedTo;
        if (DeclaredType is not null) yield return DeclaredType;
        if (Parameters is not null) foreach (var p in Parameters) yield return p;
        if (LocalVariables is not null) foreach (var l in LocalVariables) yield return l;
        if (Value is not null) foreach (var k in Value.References()) yield return k;
    }

    /// <summary>§4: a key is present exactly when its trait is declared (declaredType may be absent).</summary>
    public void Validate()
    {
        Require(Traits.Contains(Model.Traits.TNamed), Name is not null, "name", Model.Traits.TNamed);
        Require(Traits.Contains(Model.Traits.TSourceAnchor), Anchor is not null, "anchor", Model.Traits.TSourceAnchor);
        Require(Traits.Contains(Model.Traits.TComment), Comments is not null, "comments", Model.Traits.TComment);
        Require(Traits.Contains(Model.Traits.TChildOf), Parent is not null, "parent", Model.Traits.TChildOf);
        Require(Traits.Contains(Model.Traits.TAttachedTo), AttachedTo is not null, "attachedTo", Model.Traits.TAttachedTo);
        Require(Traits.Contains(Model.Traits.TModule), DefinedIn is not null, "definedIn", Model.Traits.TModule);
        Require(Traits.Contains(Model.Traits.TModule) || Traits.Contains(Model.Traits.TType), IsStub is not null, "isStub", "TModule/TType");
        Require(Traits.Contains(Model.Traits.TInvocable), Signature is not null, "signature", Model.Traits.TInvocable);
        Require(Traits.Contains(Model.Traits.TWithParameters), Parameters is not null, "parameters", Model.Traits.TWithParameters);
        Require(Traits.Contains(Model.Traits.TWithLocalVariables), LocalVariables is not null, "localVariables", Model.Traits.TWithLocalVariables);
        Require(Traits.Contains(Model.Traits.TMetrics), Metrics is not null, "metrics", Model.Traits.TMetrics);
        Require(Traits.Contains(Model.Traits.TWithValue), Value is not null, "value", Model.Traits.TWithValue);
        if (DeclaredType is not null && !Traits.Contains(Model.Traits.TTypedEntity))
            throw new InvalidOperationException($"{Key}: declaredType present without TTypedEntity");
        if (Comments is not null && Comments.Count == 0)
            throw new InvalidOperationException($"{Key}: TComment with no comment text");
        if (Metrics is not null && Metrics.Count == 0)
            throw new InvalidOperationException($"{Key}: TMetrics with no measure");
        Anchor?.Validate();
        if (Key.IsModule != Traits.Contains(Model.Traits.TModule))
            throw new InvalidOperationException($"{Key}: a module key must carry TModule and vice versa");
    }

    private void Require(bool declared, bool present, string key, string trait)
    {
        if (declared && !present) throw new InvalidOperationException($"{Key}: {trait} declared but `{key}` is missing");
        if (!declared && present) throw new InvalidOperationException($"{Key}: `{key}` present without {trait}");
    }
}

/// <summary>An outgoing relation; provenance and anchor are mandatory (§5).</summary>
public sealed record Edge(string Kind, NaturalKey From, NaturalKey To, string Provenance, SourceAnchor Anchor)
{
    public string? SourceFile { get; init; }
    public bool? IsRead { get; init; }
    public bool? IsWrite { get; init; }
    public List<NamedArgument>? Arguments { get; init; }

    public IEnumerable<NaturalKey> References()
    {
        yield return From;
        yield return To;
        if (Arguments is not null)
            foreach (var argument in Arguments)
                foreach (var k in argument.Value.References()) yield return k;
    }
}

public sealed record NamedArgument(string Name, Literal Value);

/// <summary>Where the corpus lives in a hosted repository (METAMODEL.md §8a); copied verbatim from the flags.</summary>
public sealed record Repository(string Remote, string Commit, string Root, string? Provider)
{
    private static readonly System.Text.RegularExpressions.Regex RemoteShape =
        new(@"^https://(?![^\s]*\.git$)[^\s?#]*[^\s?#/]$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    private static readonly System.Text.RegularExpressions.Regex CommitShape =
        new(@"^[0-9a-f]{7,64}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    private static readonly System.Text.RegularExpressions.Regex RootShape =
        new(@"^$|^(?!\.\.?(?:/|$))[^/\s]+(?:/(?!\.\.?(?:/|$))[^/\s]+)*$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    public static Repository Parse(string remote, string commit, string root, string? provider)
    {
        if (!RemoteShape.IsMatch(remote))
            throw new UsageException($"--repo-remote must be a normalized https URL with no .git suffix (https://github.com/owner/repo), got: {remote}");
        if (!CommitShape.IsMatch(commit))
            throw new UsageException($"--repo-commit must be a lowercase hex sha — a branch name moves and is not a fact, got: {commit}");
        if (!RootShape.IsMatch(root))
            throw new UsageException($"--repo-root must be a repo-relative path with no leading slash or dot segments, got: {root}");
        if (provider is not null && provider is not ("github" or "gitlab"))
            throw new UsageException($"--repo-provider must be github or gitlab, got: {provider}");
        return new Repository(remote, commit, root, provider);
    }
}

public sealed record ExtractorInfo(string Name, string Version);

public sealed class UsageException(string message) : Exception(message);

/// <summary>The whole model before encoding; the writer sorts, interns and numbers it.</summary>
public sealed class ExtractedModel
{
    public required ExtractorInfo Extractor { get; init; }
    public required string Root { get; init; }
    public Repository? Repository { get; init; }
    public List<Entity> Entities { get; } = [];
    public List<Edge> Edges { get; } = [];
}
