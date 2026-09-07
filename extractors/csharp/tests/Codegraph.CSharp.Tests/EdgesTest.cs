using Codegraph.CSharp.Model;

namespace Codegraph.CSharp.Tests;

/// <summary>Pass 3, one relation per test: what is written is an edge, from the nearest declared owner, to the declared member or its type.</summary>
public class EdgesTest
{
    private static IEnumerable<Edge> Of(ExtractedModel model, string kind, string from) =>
        model.Edges.Where(e => e.Kind == kind && e.From.Render() == from);

    private static string[] Targets(ExtractedModel model, string kind, string from) =>
        Of(model, kind, from).Select(e => e.To.Render()).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToArray();

    [Fact]
    public void ACallToACorpusMethodTargetsTheMethodAndToAnExternalOneItsType()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class A {
                public void Run() { Helper(); System.Console.WriteLine("x"); }
                private static void Helper() {}
              }
            }
            """)).Model;
        Assert.Equal(["csharp:N/A.Helper()", "csharp:System/Console"], Targets(model, "invocation", "csharp:N/A.Run()"));
    }

    [Fact]
    public void FieldAndPropertyAccessesCarryReadAndWrite()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class A {
                private int count;
                public int Count { get; set; }
                public void Run() { count = 1; count += 2; count++; var x = count; Count = x; x = Count; }
              }
            }
            """)).Model;
        var accesses = Of(model, "access", "csharp:N/A.Run()").ToList();
        var toField = accesses.Where(e => e.To.Render() == "csharp:N/A.count").OrderBy(e => e.Anchor.StartLine).ToList();
        // One line, four uses of `count`: write, read+write, read+write, read — deduplicated by anchor → the kinds seen.
        Assert.Contains(toField, e => e.IsWrite == true && e.IsRead != true);
        Assert.Contains(toField, e => e.IsWrite == true && e.IsRead == true);
        Assert.Contains(toField, e => e.IsRead == true && e.IsWrite != true);
        Assert.Contains(accesses, e => e.To.Render() == "csharp:N/A.Count" && e.IsWrite == true);
        Assert.Contains(accesses, e => e.To.Render() == "csharp:N/A.Count" && e.IsRead == true);
    }

    [Fact]
    public void AnExtensionMethodCallSiteInvokesTheStaticMethodWhichIsAttachedToTheExtendedType()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public record struct Money(long Cents);
              public static class Ext { public static Money Doubled(this Money m) => new Money(m.Cents * 2); }
              public class A { public Money Run(Money m) => m.Doubled(); }
            }
            """)).Model;
        Assert.Equal(["csharp:N/Ext.Doubled(N.Money)"], Targets(model, "invocation", "csharp:N/A.Run(N.Money)"));
        Assert.Equal(new NaturalKey("N", "Money"), Harness.EntityOf(model, "csharp:N/Ext.Doubled(N.Money)").AttachedTo);
    }

    [Fact]
    public void ADynamicCallSiteIsDroppedAndCounted()
    {
        var result = Harness.Extract(("A.cs", "namespace N { public class A { public object Run(dynamic d) => d.Anything(); } }"));
        Assert.Empty(Of(result.Model, "invocation", "csharp:N/A.Run(System.Object)"));
        Assert.Equal(1, result.Stats.DynamicCallSitesDropped);
    }

    [Fact]
    public void AMethodGroupUsedAsAValueIsAReferenceToTheMethod()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class A {
                public System.Action Run() { System.Action a = Helper; return a; }
                private static void Helper() {}
              }
            }
            """)).Model;
        Assert.Contains("csharp:N/A.Helper()", Targets(model, "reference", "csharp:N/A.Run()"));
        Assert.Empty(Of(model, "invocation", "csharp:N/A.Run()"));
    }

    [Fact]
    public void ThrowSitesAndRethrowsTargetTheThrownType()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class E : System.Exception {}
              public class A {
                public void Run(int q) {
                  if (q < 0) throw new E();
                  try { Run(1); } catch (E e) { throw e; }
                  try { Run(2); } catch (System.InvalidOperationException) { throw; }
                }
              }
            }
            """)).Model;
        var throws = Of(model, "throws", "csharp:N/A.Run(System.Int32)").OrderBy(e => e.Anchor.StartLine).ToList();
        Assert.Equal(["csharp:N/E", "csharp:N/E", "csharp:System/InvalidOperationException"], throws.Select(e => e.To.Render()));
        Assert.Equal([5, 6, 7], throws.Select(e => e.Anchor.StartLine));
    }

    [Fact]
    public void AnAttributeIsAnAnnotationUseWithNamedArguments()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public enum Level { Low, High }
              public class TagAttribute : System.Attribute {
                public TagAttribute(string name, int weight = 1) {}
                public Level Level { get; set; }
                public System.Type Kind { get; set; }
                public string[] Aliases { get; set; }
              }
              [Tag("x", 2, Level = Level.High, Kind = typeof(A), Aliases = new[] { "a", "b" })]
              public class A { [Tag(Unknown.Value)] public void Run() {} }
            }
            """)).Model;
        var onA = Of(model, "annotationUse", "csharp:N/A").Single();
        Assert.Equal("csharp:N/TagAttribute", onA.To.Render());
        Assert.Equal(["name", "weight", "Level", "Kind", "Aliases"], onA.Arguments!.Select(a => a.Name));
        Assert.Equal(new Literal.String("x"), onA.Arguments![0].Value);
        Assert.Equal(new Literal.Number("2"), onA.Arguments![1].Value);
        Assert.Equal(new Literal.Enum(new NaturalKey("N", "Level"), "High"), onA.Arguments![2].Value);
        Assert.Equal(new Literal.TypeValue(new NaturalKey("N", "A")), onA.Arguments![3].Value);
        Assert.Equal(new Literal.Array([new Literal.String("a"), new Literal.String("b")]).Items.Count, ((Literal.Array)onA.Arguments![4].Value).Items.Count);
        var onRun = Of(model, "annotationUse", "csharp:N/A.Run()").Single();
        Assert.Equal(new NamedArgument("name", new Literal.Unevaluated("Unknown.Value")), onRun.Arguments!.Single());
        // The attribute's arguments never leak as accesses or references.
        Assert.Empty(Of(model, "access", "csharp:N/A"));
    }

    [Fact]
    public void AnUnboundReceiverIsAReferenceToAStubNamedAsWritten()
    {
        var model = Harness.Extract(("A.cs", "namespace N { public class A { public string Run(object o) => JsonConvert.SerializeObject(o); } }")).Model;
        Assert.Contains("csharp:<unresolved>/JsonConvert", Targets(model, "reference", "csharp:N/A.Run(System.Object)"));
        Assert.True(Harness.EntityOf(model, "csharp:<unresolved>/JsonConvert").IsStub);
        Assert.Empty(Of(model, "invocation", "csharp:N/A.Run(System.Object)"));
    }

    [Fact]
    public void AMemberOfAnUnresolvedBaseAddsNothingBeyondTheBase()
    {
        var model = Harness.Extract(("A.cs", "namespace N { public class A : Unknown { public void Run() { base.Post(1); trail.Record(); } } }")).Model;
        // The <unresolved> module exists only as the stubs' container: nothing but an import may target a module.
        Assert.DoesNotContain(model.Edges, e => e.To.IsModule && e.Kind != "import");
        Assert.DoesNotContain(model.Edges, e => e.To.Render() == "csharp:<unresolved>/Post" || e.To.Render() == "csharp:<unresolved>/Record");
        Assert.NotNull(Harness.Find(model, "csharp:<unresolved>/Unknown"));
        Assert.NotNull(Harness.Find(model, "csharp:<unresolved>/trail"));
    }

    [Fact]
    public void ALambdaOwnsWhatItWritesAndTheEnclosingMethodOwnsTheRest()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class A {
                private int n;
                public System.Func<int, int> Run() { n = 1; return x => x + n; }
              }
            }
            """)).Model;
        var lambda = model.Entities.Single(e => e.Kind == "lambda");
        Assert.Equal(new NaturalKey("N", "A.Run()"), lambda.Parent);
        Assert.Equal(["csharp:N/A.n"], Targets(model, "access", lambda.Key.Render()));
        Assert.Contains(Of(model, "access", "csharp:N/A.Run()"), e => e.To.Render() == "csharp:N/A.n" && e.IsWrite == true);
        Assert.Equal(new NaturalKey("N", "A", lambda.Key.Disambiguator + "#param:x"), lambda.Parameters!.Single());
    }

    [Fact]
    public void ForeachAndCatchLocalsDoNotOwnTheirBodies()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class A {
                private int n;
                public void Run(int[] xs) {
                  foreach (var x in xs) { n = x; }
                  try {} catch (System.Exception e) { n = 2; }
                }
              }
            }
            """)).Model;
        Assert.All(Of(model, "access", "csharp:N/A.Run(System.Int32[])"), e => Assert.Equal("csharp:N/A.n", e.To.Render()));
        Assert.Equal(2, Of(model, "access", "csharp:N/A.Run(System.Int32[])").Count());
        Assert.Equal(2, Harness.EntityOf(model, "csharp:N/A.Run(System.Int32[])").LocalVariables!.Count);
    }

    [Fact]
    public void UsingDirectivesAndAliasesFoldToNamespaces()
    {
        var model = Harness.Extract(("A.cs", "using static System.Math;\nusing L = System.Collections.Generic.List<int>;\nnamespace N { public class A { public double R(double v) => Round(v); } }")).Model;
        Assert.Equal(["csharp:System", "csharp:System.Collections.Generic"], Targets(model, "import", "csharp:N"));
        Assert.Equal(["csharp:System/Math"], Targets(model, "invocation", "csharp:N/A.R(System.Double)"));
    }
}
