namespace Codegraph.CSharp.Model;

/// <summary>
/// The natural key (METAMODEL.md §1.1): `(lang, module, symbol, disambiguator?)`
/// with lang fixed to `csharp`. Identity is component-wise; the rendered form
/// `csharp:module/symbol#disambiguator` is a display projection only, never
/// written to the file (the file carries surrogates).
/// </summary>
public sealed class NaturalKey : IEquatable<NaturalKey>, IComparable<NaturalKey>
{
    public const string Lang = "csharp";

    /// <summary>The global namespace's module name — `<` and `>` are not reserved separators.</summary>
    public const string GlobalModule = "<global>";

    /// <summary>The reserved module for names Roslyn could not bind (PLAN.md §13.4).</summary>
    public const string UnresolvedModule = "<unresolved>";

    public string Module { get; }
    public string Symbol { get; }
    public string? Disambiguator { get; }

    public NaturalKey(string module, string symbol, string? disambiguator = null)
    {
        Reject(module, "module", '/', '#', '\0');
        Reject(symbol, "symbol", '#', '\0');
        if (disambiguator is not null) Reject(disambiguator, "disambiguator", '\0');
        if (module.Length == 0) throw new ArgumentException("module may not be empty", nameof(module));
        Module = module;
        Symbol = symbol;
        Disambiguator = disambiguator;
    }

    public static NaturalKey OfModule(string module) => new(module, "");

    /// <summary>A module names itself: empty symbol, no disambiguator (§2 of the contract).</summary>
    public bool IsModule => Symbol.Length == 0 && Disambiguator is null;

    public NaturalKey ModuleKey => IsModule ? this : OfModule(Module);

    public string Render() =>
        Lang + ":" + Module + (Symbol.Length == 0 ? "" : "/" + Symbol) +
        (Disambiguator is null ? "" : "#" + Disambiguator);

    private static void Reject(string value, string component, params char[] reserved)
    {
        foreach (var c in reserved)
        {
            if (value.Contains(c))
            {
                var shown = c == '\0' ? "NUL" : $"\"{c}\"";
                throw new ArgumentException($"{component} may not contain {shown} — it is a reserved separator: {value}", component);
            }
        }
    }

    /// <summary>Canonical order (§6): UTF-16 code units, an absent disambiguator first.</summary>
    public int CompareTo(NaturalKey? other)
    {
        if (other is null) return 1;
        var head = string.CompareOrdinal(Module, other.Module);
        if (head != 0) return head;
        head = string.CompareOrdinal(Symbol, other.Symbol);
        if (head != 0) return head;
        if (Disambiguator == other.Disambiguator) return 0;
        if (Disambiguator is null) return -1;
        if (other.Disambiguator is null) return 1;
        return string.CompareOrdinal(Disambiguator, other.Disambiguator);
    }

    public bool Equals(NaturalKey? other) =>
        other is not null && Module == other.Module && Symbol == other.Symbol && Disambiguator == other.Disambiguator;

    public override bool Equals(object? obj) => Equals(obj as NaturalKey);

    public override int GetHashCode() => HashCode.Combine(Module, Symbol, Disambiguator);

    public override string ToString() => Render();
}
