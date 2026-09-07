using Codegraph.CSharp.Model;

namespace Codegraph.CSharp.Tests;

/// <summary>
/// PLAN.md §13.4: membership is the declared-type whitelist, never a
/// namespace-prefix test; a metadata type is a stub in its real namespace; an
/// error type is a stub in `&lt;unresolved&gt;`, named as written.
/// </summary>
public class StubDisciplineTest
{
    [Fact]
    public void ACorpusTypeInsideTheSystemNamespaceStaysInternal()
    {
        var model = Harness.Extract(
            ("Acme.cs", "namespace System.Acme { public class Widget : System.Exception {} }")).Model;
        Assert.False(Harness.EntityOf(model, "csharp:System.Acme/Widget").IsStub);
        Assert.False(Harness.EntityOf(model, "csharp:System.Acme").IsStub);
        Assert.True(Harness.EntityOf(model, "csharp:System/Exception").IsStub);
        Assert.True(Harness.EntityOf(model, "csharp:System").IsStub);
    }

    [Fact]
    public void AnUnresolvedNameInTheCorpusOwnNamespaceIsAStubInUnresolved()
    {
        var model = Harness.Extract(
            ("A.cs", "namespace Acme { public class Adapter : LedgerClient {} }")).Model;
        var stub = Harness.EntityOf(model, "csharp:<unresolved>/LedgerClient");
        Assert.True(stub.IsStub);
        Assert.Equal("class", stub.Kind);
        Assert.Equal("LedgerClient", stub.Name);
        Assert.Equal(NaturalKey.OfModule(NaturalKey.UnresolvedModule), stub.Parent);
        Assert.True(Harness.EntityOf(model, "csharp:<unresolved>").IsStub);
        // Nothing was invented inside the corpus's own namespace.
        Assert.Null(Harness.Find(model, "csharp:Acme/LedgerClient"));
    }

    [Fact]
    public void MetadataStubsKeepTheirRealKindAndArity()
    {
        var model = Harness.Extract(
            ("A.cs", "namespace Acme { public class Widget : System.Collections.Generic.List<int>, System.IDisposable { public void Dispose() {} } }")).Model;
        var list = Harness.EntityOf(model, "csharp:System.Collections.Generic/List`1");
        Assert.True(list.IsStub);
        Assert.Equal("class", list.Kind);
        Assert.Equal("List", list.Name);
        var disposable = Harness.EntityOf(model, "csharp:System/IDisposable");
        Assert.Equal("interface", disposable.Kind);
        Assert.Equal(["TNamed", "TType", "TChildOf"], list.Traits);
    }

    [Fact]
    public void FixtureEvidence()
    {
        var model = Harness.FixtureModel;
        // The corpus's own List, whose SIMPLE name is a BCL type's, is internal…
        Assert.False(Harness.EntityOf(model, "csharp:Acme.Order.Legacy/List").IsStub);
        // …the BCL's is a stub in ITS namespace, arity and all…
        Assert.True(Harness.EntityOf(model, "csharp:System.Collections.Generic").IsStub);
        // …and a name no reference resolves is a stub in <unresolved>, not in the corpus's namespace.
        Assert.True(Harness.EntityOf(model, "csharp:<unresolved>/LedgerClient").IsStub);
        Assert.True(Harness.EntityOf(model, "csharp:<unresolved>/JsonConverter").IsStub);
        Assert.Null(Harness.Find(model, "csharp:Acme.Order.Adapter/LedgerClient"));
        // The `using` still says what was imported, as a stub namespace.
        Assert.True(Harness.EntityOf(model, "csharp:Newtonsoft.Json").IsStub);
        Assert.True(Harness.EntityOf(model, "csharp:MegaCorp.Ledger").IsStub);
        // Nested types are entities in their own right.
        Assert.False(Harness.EntityOf(model, "csharp:Acme.Order/Basket.Line.Discount").IsStub);
        // Repository and Repository<T> are two entities.
        Assert.False(Harness.EntityOf(model, "csharp:Acme.Order/Repository").IsStub);
        Assert.False(Harness.EntityOf(model, "csharp:Acme.Order/Repository`1").IsStub);
    }

    [Fact]
    public void EveryReferenceIsDeclaredAndNoEdgeIsASelfEdge()
    {
        var model = Harness.FixtureModel;
        var declared = model.Entities.Select(e => e.Key).ToHashSet();
        foreach (var entity in model.Entities)
            foreach (var reference in entity.References())
                Assert.True(declared.Contains(reference), $"{entity.Key} -> {reference}");
        foreach (var edge in model.Edges)
        {
            Assert.True(declared.Contains(edge.From), edge.From.Render());
            Assert.True(declared.Contains(edge.To), edge.To.Render());
            Assert.NotEqual(edge.From, edge.To);
        }
    }

    [Fact]
    public void NoEntityIsItsOwnParentAndParentsAreContainers()
    {
        var byKey = Harness.FixtureModel.Entities.ToDictionary(e => e.Key);
        foreach (var entity in byKey.Values)
        {
            if (entity.Parent is null) continue;
            Assert.NotEqual(entity.Key, entity.Parent);
            Assert.True(byKey[entity.Parent].Has(Traits.TWithChildren), $"{entity.Parent} holds {entity.Key} but declares no TWithChildren");
        }
    }

    [Fact]
    public void StubsCarryNoEvidenceAndModulesNameThemselves()
    {
        foreach (var entity in Harness.FixtureModel.Entities)
        {
            if (entity.IsStub == true)
            {
                Assert.Null(entity.Anchor);
                Assert.Null(entity.Comments);
                Assert.Null(entity.Metrics);
                if (entity.Key.IsModule) Assert.Empty(entity.DefinedIn!);
            }
            if (entity.Key.IsModule) Assert.Equal("namespace", entity.Kind);
        }
    }

    [Fact]
    public void AnImportWithNoDeclaringModuleIsDroppedAndCounted()
    {
        var result = Harness.Extract(("Only.cs", "using System;\n"));
        Assert.Empty(result.Model.Edges);
        Assert.Equal(1, result.Stats.ImportsWithoutModule);
    }

    [Fact]
    public void ASelfImportIsDroppedAndCounted()
    {
        var result = Harness.Extract(("A.cs", "using Acme;\nnamespace Acme { public class A {} }"));
        Assert.Empty(result.Model.Edges);
        Assert.Equal(1, result.Stats.SelfEdgesDropped);
    }

    [Fact]
    public void TheSummaryReportsWhatWasCounted()
    {
        var result = Harness.FixtureResult;
        var summary = result.Stats.Summary(result.Model.Entities.Count, result.Stubs, result.Model.Edges.Count);
        Assert.Contains("RESOLUTION SUMMARY", summary, StringComparison.Ordinal);
        Assert.Contains($"entities        : {result.Model.Entities.Count} (stubs: {result.Stubs})", summary, StringComparison.Ordinal);
        Assert.True(result.Stats.Unresolved > 0, "the fixture has unresolvable bases on purpose");
    }
}
