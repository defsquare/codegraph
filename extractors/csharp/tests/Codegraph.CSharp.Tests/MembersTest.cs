using Codegraph.CSharp.Model;

namespace Codegraph.CSharp.Tests;

/// <summary>Pass 2 below the type: members, parameters, locals, lambdas, local functions, values.</summary>
public class MembersTest
{
    [Fact]
    public void MembersGetTheirKindsAndKeys()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class A {
                public const int Max = 4 * 25;
                private readonly int n = 1;
                public int P { get; set; }
                public int this[int i] => i;
                public event System.Action? E;
                public A() {}
                public static A operator +(A l, A r) => l;
                public static implicit operator int(A a) => 0;
                public void M<T>(T t, System.Collections.Generic.List<T> ts) {}
                ~A() {}
              }
            }
            """)).Model;
        Assert.Equal("field", Harness.EntityOf(model, "csharp:N/A.Max").Kind);
        Assert.Equal(new Literal.Number("100"), Harness.EntityOf(model, "csharp:N/A.Max").Value);
        Assert.Null(Harness.EntityOf(model, "csharp:N/A.n").Value);
        Assert.Equal("property", Harness.EntityOf(model, "csharp:N/A.P").Kind);
        Assert.Equal("this[]", Harness.EntityOf(model, "csharp:N/A.Item(System.Int32)").Name);
        Assert.Equal("event", Harness.EntityOf(model, "csharp:N/A.E").Kind);
        Assert.Equal("constructor", Harness.EntityOf(model, "csharp:N/A.<init>()").Kind);
        Assert.Equal("method", Harness.EntityOf(model, "csharp:N/A.op_Addition(N.A,N.A)").Kind);
        Assert.Equal("method", Harness.EntityOf(model, "csharp:N/A.op_Implicit(N.A):System.Int32").Kind);
        Assert.Equal("M`1(!!0,System.Collections.Generic.List`1<!!0>)", Harness.EntityOf(model, "csharp:N/A.M`1(!!0,System.Collections.Generic.List`1<!!0>)").Signature);
        Assert.Equal("method", Harness.EntityOf(model, "csharp:N/A.Finalize()").Kind);
    }

    [Fact]
    public void SynthesizedMembersAreNotEntitiesButTheImplicitConstructorIs()
    {
        var model = Harness.Extract(("A.cs", "namespace N { public record R(int X); public class C { public int P { get; set; } } }")).Model;
        var ids = model.Entities.Select(e => e.Key.Render()).ToList();
        Assert.Contains("csharp:N/R.<init>(System.Int32)", ids);
        Assert.Contains("csharp:N/R.X", ids);
        Assert.Contains("csharp:N/C.<init>()", ids);
        Assert.DoesNotContain(ids, id => id.Contains("Equals") || id.Contains("Deconstruct") || id.Contains("PrintMembers") || id.Contains("Clone") || id.Contains("get_") || id.Contains("k__BackingField"));
        // The implicit constructor has no line of its own: anchored at the type's header.
        var implicitCtor = Harness.EntityOf(model, "csharp:N/C.<init>()");
        Assert.Equal(Harness.EntityOf(model, "csharp:N/C").Anchor!.StartLine, implicitCtor.Anchor!.StartLine);
        Assert.Equal(implicitCtor.Anchor.StartLine, implicitCtor.Anchor.EndLine);
    }

    [Fact]
    public void EnumMembersCarryTheirIntegralValueAndParametersTheirDefaults()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public enum Level : byte { Low, High = 10 }
              public class A { public void Run(int retries = 3, Level level = Level.High, string? name = null, double f = 1.5) {} }
            }
            """)).Model;
        Assert.Equal(new Literal.Number("0"), Harness.EntityOf(model, "csharp:N/Level.Low").Value);
        Assert.Equal(new Literal.Number("10"), Harness.EntityOf(model, "csharp:N/Level.High").Value);
        const string run = "csharp:N/A.Run(System.Int32,N.Level,System.String,System.Double)";
        Assert.Equal(new Literal.Number("3"), Harness.EntityOf(model, run + "#param:retries").Value);
        Assert.Equal(new Literal.Enum(new NaturalKey("N", "Level"), "High"), Harness.EntityOf(model, run + "#param:level").Value);
        Assert.Equal(new Literal.Null(), Harness.EntityOf(model, run + "#param:name").Value);
        Assert.Equal(new Literal.Number("1.5"), Harness.EntityOf(model, run + "#param:f").Value);
    }

    [Fact]
    public void LocalsLambdasAndLocalFunctionsNestBelowTheirInvocable()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class A {
                public int Run(int[] xs) {
                  int total = 0;
                  foreach (var x in xs) total += x;
                  int Twice(int v) { var w = v * 2; return w; }
                  System.Func<int, int> f = v => { var u = v; return Twice(u); };
                  return f(total);
                }
              }
            }
            """)).Model;
        const string run = "csharp:N/A.Run(System.Int32[])";
        var method = Harness.EntityOf(model, run);
        Assert.Equal([run + "#local:total:4:11", run + "#local:x:5:20", run + "#local:f:7:29"], method.LocalVariables!.Select(k => k.Render()));
        var twice = Harness.EntityOf(model, run + "#fn:Twice(System.Int32)");
        Assert.Equal("method", twice.Kind);
        Assert.Equal(new NaturalKey("N", "A.Run(System.Int32[])"), twice.Parent);
        Assert.Equal([run + "#fn:Twice(System.Int32)#param:v"], twice.Parameters!.Select(k => k.Render()));
        Assert.Equal([run + "#fn:Twice(System.Int32)#local:w:6:30"], twice.LocalVariables!.Select(k => k.Render()));
        var lambda = model.Entities.Single(e => e.Kind == "lambda");
        Assert.Equal("csharp:N/A#A.cs:7:33", lambda.Key.Render());
        Assert.Equal(method.Key, lambda.Parent);
        Assert.Equal(["csharp:N/A#A.cs:7:33#local:u:7:44"], lambda.LocalVariables!.Select(k => k.Render()));
        Assert.Equal("(System.Int32)", lambda.Signature);
        Assert.Equal(new NaturalKey("System", "Int32"), lambda.DeclaredType);
    }

    [Fact]
    public void TwoLambdasOnOneLineWithTheSameParameterNameStayDistinct()
    {
        var model = Harness.Extract(("A.cs", "namespace N { public class A { public void Run(System.Action<int> a, System.Action<int> b) { Run(x => {}, x => {}); } } }")).Model;
        var lambdas = model.Entities.Where(e => e.Kind == "lambda").ToList();
        Assert.Equal(2, lambdas.Count);
        var parameters = model.Entities.Where(e => e.Kind == "parameter" && e.Name == "x").Select(e => e.Key.Render()).ToList();
        Assert.Equal(2, parameters.Count);
        Assert.NotEqual(parameters[0], parameters[1]);
    }

    [Fact]
    public void ALambdaInAFieldInitializerBelongsToTheType()
    {
        var model = Harness.Extract(("A.cs", "namespace N { public class A { private readonly System.Func<int> f = () => 1; } }")).Model;
        var lambda = model.Entities.Single(e => e.Kind == "lambda");
        Assert.Equal(new NaturalKey("N", "A"), lambda.Parent);
    }

    [Fact]
    public void AccessorBodiesChargeToTheProperty()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class A {
                private int n;
                public int P { get { var v = n; return v; } set { n = value; } }
                public int Auto { get; init; }
              }
            }
            """)).Model;
        var p = Harness.EntityOf(model, "csharp:N/A.P");
        Assert.True(p.Has(Traits.TWithInvocations));
        Assert.Null(p.LocalVariables);
        Assert.Equal(p.Key, Harness.EntityOf(model, "csharp:N/A.P#local:v:4:30").Parent);
        Assert.False(Harness.EntityOf(model, "csharp:N/A.Auto").Has(Traits.TWithAccesses));
        Assert.Contains(model.Edges, e => e.Kind == "access" && e.From.Render() == "csharp:N/A.P" && e.IsWrite == true);
    }

    [Fact]
    public void APartialMethodIsOneEntity()
    {
        var model = Harness.Extract(
            ("A.cs", "namespace N { public partial class A { partial void Hook(); public void Run() => Hook(); } }"),
            ("B.cs", "namespace N { public partial class A { partial void Hook() { } } }")).Model;
        Assert.Single(model.Entities, e => e.Key.Render() == "csharp:N/A.Hook()");
        Assert.Contains(model.Edges, e => e.Kind == "invocation" && e.To.Render() == "csharp:N/A.Hook()");
    }
}
