using System.Globalization;
using System.Text;

namespace Codegraph.CSharp;

/// <summary>
/// The stderr summary, in the Java extractor's format. The rate measures the
/// corpus's DEPENDENCY SURFACE (PLAN.md §5.3): a package that is not under the
/// roots cannot be resolved by any extractor, so a low rate is a fact about
/// the corpus, and the stub discipline is the property worth asserting.
/// </summary>
public sealed class ResolutionStats
{
    public int TypeReferences { get; private set; }
    public int Unresolved { get; private set; }
    public int Imports { get; private set; }
    public int ImportsUnresolved { get; private set; }
    public int ImportsWithoutModule { get; set; }
    public int SelfEdgesDropped { get; set; }
    public int DynamicCallSitesDropped { get; set; }
    /// <summary>Same-keyed declarations from different files, later ones re-keyed by file (`key -> key#in:file`).</summary>
    public IReadOnlyList<string> DuplicateDeclarations { get; set; } = [];

    public int Resolved => TypeReferences - Unresolved;

    public void NoteTypeReference(bool resolved)
    {
        TypeReferences++;
        if (!resolved) Unresolved++;
    }

    public void NoteImport(bool resolved)
    {
        Imports++;
        if (!resolved) ImportsUnresolved++;
    }

    public string Summary(int entities, int stubs, int edges)
    {
        var rate = TypeReferences == 0 ? 100.0 : 100.0 * Resolved / TypeReferences;
        var sb = new StringBuilder();
        sb.Append("RESOLUTION SUMMARY\n");
        sb.Append(CultureInfo.InvariantCulture, $"  type references : {TypeReferences}\n");
        sb.Append(CultureInfo.InvariantCulture, $"  resolved        : {Resolved}\n");
        sb.Append(CultureInfo.InvariantCulture, $"  unresolved      : {Unresolved}\n");
        sb.Append(CultureInfo.InvariantCulture, $"  resolution rate : {rate:0.0}%\n");
        sb.Append(CultureInfo.InvariantCulture, $"  imports         : {Imports} (unresolved: {ImportsUnresolved}, without a module: {ImportsWithoutModule})\n");
        sb.Append(CultureInfo.InvariantCulture, $"  entities        : {entities} (stubs: {stubs})\n");
        sb.Append(CultureInfo.InvariantCulture, $"  edges           : {edges} (self-edges dropped: {SelfEdgesDropped}, dynamic call sites dropped: {DynamicCallSitesDropped})\n");
        sb.Append(CultureInfo.InvariantCulture, $"  duplicates      : {DuplicateDeclarations.Count} same-keyed declarations re-keyed by file (first in file order keeps the plain key)\n");
        return sb.ToString();
    }
}
