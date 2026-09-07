using Codegraph.CSharp.Model;

namespace Codegraph.CSharp.Tests;

/// <summary>
/// The embedded BCL binds (PLAN.md §13.1): `string` must resolve to a stub in
/// module `System`, never to `&lt;unresolved&gt;`. Under `dotnet run` the tutorial
/// approach would pass too — the published-binary smoke test (test.sh) is what
/// catches the single-file `Assembly.Location` trap; this pins the in-process half.
/// </summary>
public class ReferenceAssembliesTest
{
    [Fact]
    public void TheReferencePackIsEmbeddedAndLoads()
    {
        Assert.True(ReferenceAssemblies.Count > 100, $"only {ReferenceAssemblies.Count} reference assemblies embedded");
        Assert.Contains(ReferenceAssemblies.All, r => r.Display == "System.Runtime.dll");
    }

    [Fact]
    public void BclTypesResolveToStubsInTheirRealNamespace()
    {
        var model = Harness.Extract(("A.cs", "namespace N { public class A : System.Exception, System.IDisposable { public void Dispose() {} } public delegate string F(System.Collections.Generic.List<int> xs); }")).Model;
        Assert.NotNull(Harness.Find(model, "csharp:System/Exception"));
        Assert.NotNull(Harness.Find(model, "csharp:System/String"));
        Assert.NotNull(Harness.Find(model, "csharp:System.Collections.Generic/List`1"));
        Assert.Null(Harness.Find(model, "csharp:<unresolved>/Exception"));
        Assert.Null(Harness.Find(model, "csharp:<unresolved>"));
        Assert.Equal(NaturalKey.OfModule("System"), Harness.EntityOf(model, "csharp:System/String").Parent);
    }
}
