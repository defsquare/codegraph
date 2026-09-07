using Codegraph.CSharp.Model;

namespace Codegraph.CSharp.Tests;

/// <summary>
/// What real corpora taught the extractor (PLAN §13.6, the M12c audit): each
/// case below aborted a whole extraction or hid a real dependency before it
/// was a test — Humanizer, dotnet/eShop and OrchardCore, in that order.
/// </summary>
public class CorpusLoadTest
{
    [Fact]
    public void OverloadsDifferingOnlyInTypeArgumentsStayDistinct()
    {
        // Humanizer: Humanize<T>(IEnumerable<T>, Func<T,string>) beside Humanize<T>(IEnumerable<T>, Func<T,object>).
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public static class F {
                public static string Humanize<T>(System.Collections.Generic.IEnumerable<T> xs, System.Func<T, string> f) => "";
                public static string Humanize<T>(System.Collections.Generic.IEnumerable<T> xs, System.Func<T, object> f) => "";
                public static void Nested(System.Collections.Generic.Dictionary<string, System.Collections.Generic.List<int>> d) {}
              }
            }
            """)).Model;
        var ids = model.Entities.Where(e => e.Kind == "method").Select(e => e.Key.Render()).OrderBy(x => x, StringComparer.Ordinal).ToList();
        Assert.Equal(
            [
                "csharp:N/F.Humanize`1(System.Collections.Generic.IEnumerable`1<!!0>,System.Func`2<!!0,System.Object>)",
                "csharp:N/F.Humanize`1(System.Collections.Generic.IEnumerable`1<!!0>,System.Func`2<!!0,System.String>)",
                "csharp:N/F.Nested(System.Collections.Generic.Dictionary`2<System.String,System.Collections.Generic.List`1<System.Int32>>)",
            ],
            ids);
    }

    [Fact]
    public void ASameKeyedMemberDeclaredInTwoFilesIsKeptTwiceTheLaterOneKeyedByItsFile()
    {
        // dotnet/eShop: every service declares its own non-partial `static class Extensions`
        // and its own top-level Program.cs; dropping the later ones erased nine services' wiring.
        var result = Harness.Extract(
            ("Basket/Extensions.cs", "public static class Extensions { public static void AddApplicationServices(object b) { System.Console.WriteLine(1); } }"),
            ("Catalog/Extensions.cs", "public static class Extensions { public static void AddApplicationServices(object b) { System.Console.Beep(); } }"));
        var model = result.Model;
        var first = Harness.EntityOf(model, "csharp:<global>/Extensions.AddApplicationServices(System.Object)");
        var second = Harness.EntityOf(model, "csharp:<global>/Extensions.AddApplicationServices(System.Object)#in:Catalog/Extensions.cs");
        Assert.Equal("Basket/Extensions.cs", first.Anchor!.File);
        Assert.Equal("Catalog/Extensions.cs", second.Anchor!.File);
        // Each declaration's body contributes its own edges, and its own parameter sits below its own key.
        Assert.Single(model.Edges, e => e.Kind == "invocation" && e.From.Equals(first.Key));
        Assert.Single(model.Edges, e => e.Kind == "invocation" && e.From.Equals(second.Key));
        Assert.Equal([second.Key.Render() + "#param:b"], second.Parameters!.Select(k => k.Render()));
        Assert.Equal(
            ["csharp:<global>/Extensions.AddApplicationServices(System.Object) -> csharp:<global>/Extensions.AddApplicationServices(System.Object)#in:Catalog/Extensions.cs"],
            result.Stats.DuplicateDeclarations);
    }

    [Fact]
    public void ConversionOperatorsOverloadOnTheirReturnType()
    {
        // OrchardCore: 37 `explicit operator X(JsonDynamicValue v)` on one type.
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class V {
                public static explicit operator int(V v) => 0;
                public static explicit operator string(V v) => "";
                public static implicit operator V(int i) => new V();
              }
            }
            """)).Model;
        var ids = model.Entities.Where(e => e.Kind == "method").Select(e => e.Key.Render()).OrderBy(x => x, StringComparer.Ordinal).ToList();
        Assert.Equal(
            ["csharp:N/V.op_Explicit(N.V):System.Int32", "csharp:N/V.op_Explicit(N.V):System.String", "csharp:N/V.op_Implicit(System.Int32):N.V"],
            ids);
    }

    [Fact]
    public void DiscardParametersRepeatingANameGetTheirOrdinal()
    {
        // OrchardCore: `(_, _) => …`.
        var model = Harness.Extract(("A.cs", "namespace N { public class A { public System.Func<int, int, int> F() => (_, _) => 0; } }")).Model;
        var lambda = model.Entities.Single(e => e.Kind == "lambda");
        Assert.Equal([lambda.Key.Disambiguator + "#param:_", lambda.Key.Disambiguator + "#param:_:1"], lambda.Parameters!.Select(k => k.Disambiguator));
    }

    [Fact]
    public void AnExtensionBlockIsNoTypeAndItsMembersAttachToTheReceiver()
    {
        // Humanizer (via Polyfill): C# 14 `extension(T t) { … }` — Roslyn's nameless nested type had an empty name.
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public record struct Money(long Cents);
              public static class Ext {
                extension(Money m) {
                  public bool IsZero => m.Cents == 0;
                  public Money Doubled() => new Money(m.Cents * 2);
                }
              }
              public class A { public bool Run(Money m) => m.IsZero && m.Doubled().Cents > 0; }
            }
            """)).Model;
        Assert.All(model.Entities, e => Assert.False(e.Name == "", e.Key.Render()));
        Assert.DoesNotContain(model.Entities, e => e.Kind is "class" && e.Key.Symbol.Contains('<'));
        var isZero = Harness.EntityOf(model, "csharp:N/Ext.IsZero");
        Assert.Equal("property", isZero.Kind);
        Assert.Equal(new NaturalKey("N", "Money"), isZero.AttachedTo);
        Assert.Equal(new NaturalKey("N", "Ext"), isZero.Parent);
        var doubled = Harness.EntityOf(model, "csharp:N/Ext.Doubled()");
        Assert.Equal(new NaturalKey("N", "Money"), doubled.AttachedTo);
        var fromRun = model.Edges.Where(e => e.From.Render() == "csharp:N/A.Run(N.Money)").Select(e => e.Kind + " " + e.To.Render()).ToList();
        Assert.Contains("access csharp:N/Ext.IsZero", fromRun);
        Assert.Contains("invocation csharp:N/Ext.Doubled()", fromRun);
    }

    [Fact]
    public void ImplicitUsingsBindWhatTheSdkWouldHaveGeneratedIntoObj()
    {
        // OrchardCore: Task, Task<T>, IEnumerable<T>, List<T> were the most-referenced "unresolved" names.
        const string source = "namespace N { public class A { public Task<List<int>> Run(CancellationToken ct) => Task.FromResult(new List<int>()); } }";
        var with = Harness.Extract(("A.cs", source)).Model;
        Assert.NotNull(Harness.Find(with, "csharp:System.Threading.Tasks/Task`1"));
        Assert.Null(Harness.Find(with, "csharp:<unresolved>/Task`1"));
        // No import edge is written for them: no file wrote a using.
        Assert.DoesNotContain(with.Edges, e => e.Kind == "import");
        var without = Extraction.Run(new ExtractOptions(["."], WriteScratch(source), ImplicitUsings: ImplicitUsings.None), Progress.Silent).Model;
        Assert.NotNull(Harness.Find(without, "csharp:<unresolved>/Task`1"));
    }

    [Fact]
    public void TheWebSdkUsingsAreOptInBecauseTheyMakeCorpusNamesAmbiguous()
    {
        // OrchardCore: its own `StartupBase` collided 345 times with Microsoft.AspNetCore.Hosting.StartupBase.
        const string source = "namespace OC.Modules { public abstract class StartupBase {} }\nnamespace OC.Media { using OC.Modules; public class Startup : StartupBase { public object B => WebApplication.CreateBuilder(); } }";
        var sdk = Extraction.Run(new ExtractOptions(["."], WriteScratch(source)), Progress.Silent).Model;
        Assert.Contains(sdk.Edges, e => e.Kind == "inheritance" && e.To.Render() == "csharp:OC.Modules/StartupBase");
        Assert.NotNull(Harness.Find(sdk, "csharp:<unresolved>/WebApplication"));
        var web = Extraction.Run(new ExtractOptions(["."], WriteScratch(source), ImplicitUsings: ImplicitUsings.Web), Progress.Silent).Model;
        Assert.NotNull(Harness.Find(web, "csharp:Microsoft.AspNetCore.Builder/WebApplication"));
    }

    [Fact]
    public void TheAspNetCoreSharedFrameworkResolvesWhenEmbedded()
    {
        // eShop: ILogger<T>, IServiceCollection, WebApplication topped the unresolved list.
        Assert.True(ReferenceAssemblies.All.Any(r => r.Display == "Microsoft.AspNetCore.dll"), "the building SDK had no ASP.NET Core reference pack");
        var model = Harness.Extract(("A.cs", "using Microsoft.Extensions.DependencyInjection;\nnamespace N { public class A { public void Run(Microsoft.Extensions.Logging.ILogger<A> log, IServiceCollection s) {} } }")).Model;
        Assert.NotNull(Harness.Find(model, "csharp:Microsoft.Extensions.Logging/ILogger`1"));
        Assert.NotNull(Harness.Find(model, "csharp:Microsoft.Extensions.DependencyInjection/IServiceCollection"));
    }

    private static string WriteScratch(string source)
    {
        var scratch = Path.Combine(Path.GetTempPath(), "codegraph-csharp-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(scratch);
        File.WriteAllText(Path.Combine(scratch, "A.cs"), source);
        return scratch;
    }
}
