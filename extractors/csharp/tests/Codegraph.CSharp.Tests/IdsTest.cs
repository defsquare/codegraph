using Codegraph.CSharp.Model;

namespace Codegraph.CSharp.Tests;

/// <summary>PLAN.md §13.3 — the id scheme, one construct per test.</summary>
public class IdsTest
{
    [Fact]
    public void GenericArityIsPartOfTheSymbol()
    {
        var model = Harness.Extract(("R.cs", "namespace N { public class Repo {} public class Repo<T> {} public class Repo<T, U> {} }")).Model;
        Assert.NotNull(Harness.Find(model, "csharp:N/Repo"));
        Assert.NotNull(Harness.Find(model, "csharp:N/Repo`1"));
        Assert.NotNull(Harness.Find(model, "csharp:N/Repo`2"));
        Assert.Equal("Repo", Harness.EntityOf(model, "csharp:N/Repo`2").Name);
    }

    [Fact]
    public void NestedTypesJoinWithDotsAndParentTheOuterType()
    {
        var model = Harness.Extract(("O.cs", "namespace N { public class Outer { public class Inner<T> { public struct Deep {} } } }")).Model;
        var deep = Harness.EntityOf(model, "csharp:N/Outer.Inner`1.Deep");
        Assert.Equal(new NaturalKey("N", "Outer.Inner`1"), deep.Parent);
        Assert.Equal("struct", deep.Kind);
        Assert.Equal(NaturalKey.OfModule("N"), Harness.EntityOf(model, "csharp:N/Outer").Parent);
    }

    [Fact]
    public void TheGlobalNamespaceIsAModuleNamedGlobal()
    {
        var model = Harness.Extract(("G.cs", "public class Top {}")).Model;
        var top = Harness.EntityOf(model, "csharp:<global>/Top");
        Assert.Equal(NaturalKey.OfModule("<global>"), top.Parent);
        var global = Harness.EntityOf(model, "csharp:<global>");
        Assert.Equal("<global>", global.Name);
        Assert.Equal(["G.cs"], global.DefinedIn);
    }

    [Fact]
    public void KindsFollowTheDeclaration()
    {
        var model = Harness.Extract(("K.cs", """
            namespace N {
              public class C {}
              public interface I {}
              public struct S {}
              public enum E : byte { A }
              public record R(int X);
              public readonly record struct RS(int X);
              public delegate int D(string s, ref int n);
            }
            """)).Model;
        Assert.Equal("class", Harness.EntityOf(model, "csharp:N/C").Kind);
        Assert.Equal("interface", Harness.EntityOf(model, "csharp:N/I").Kind);
        Assert.Equal("struct", Harness.EntityOf(model, "csharp:N/S").Kind);
        Assert.Equal("enum", Harness.EntityOf(model, "csharp:N/E").Kind);
        Assert.Equal("record", Harness.EntityOf(model, "csharp:N/R").Kind);
        Assert.Equal("record", Harness.EntityOf(model, "csharp:N/RS").Kind);
        var e = Harness.EntityOf(model, "csharp:N/E");
        Assert.Equal(new NaturalKey("System", "Byte"), e.DeclaredType);
        var d = Harness.EntityOf(model, "csharp:N/D");
        Assert.Equal("delegate", d.Kind);
        Assert.Equal("D(System.String,System.Int32)", d.Signature);
        Assert.Equal(new NaturalKey("System", "Int32"), d.DeclaredType);
        Assert.Equal([new NaturalKey("N", "D", "param:s"), new NaturalKey("N", "D", "param:n")], d.Parameters);
        var s = Harness.EntityOf(model, "csharp:N/D#param:s");
        Assert.Equal("parameter", s.Kind);
        Assert.Equal(new NaturalKey("N", "D"), s.Parent);
        Assert.Equal(new NaturalKey("System", "String"), s.DeclaredType);
    }

    [Fact]
    public void SignaturesEraseToMetadataNamesWithOrdinalTypeParameters()
    {
        var model = Harness.Extract(("D.cs", """
            namespace N {
              public delegate T Pick<T, U>(System.Collections.Generic.List<T> xs, U[,] grid, int? maybe, (int, string) pair, dynamic d, T* p);
            }
            """)).Model;
        var pick = Harness.EntityOf(model, "csharp:N/Pick`2");
        Assert.Equal("Pick`2(System.Collections.Generic.List`1,!1[,],System.Nullable`1,System.ValueTuple`2,System.Object,!0*)", pick.Signature);
        // A type parameter is not an entity: the return type leaves declaredType absent.
        Assert.Null(pick.DeclaredType);
        Assert.True(pick.Has(Traits.TTypedEntity));
    }

    [Fact]
    public void PartialTypesAreOneEntityAnchoredAtTheOrdinalFirstPart()
    {
        var model = Harness.Extract(
            ("Z/Order.cs", "namespace N { public partial class Order : System.IDisposable { public void Dispose() {} } }"),
            ("A/Order.Audit.cs", "namespace N { public partial class Order : System.ICloneable { public object Clone() => this; } }")).Model;
        var order = Harness.EntityOf(model, "csharp:N/Order");
        Assert.Equal("A/Order.Audit.cs", order.Anchor!.File);
        var implements = model.Edges.Where(e => e.Kind == "interfaceImplementation" && e.From.Equals(order.Key)).ToList();
        Assert.Equal(2, implements.Count);
        Assert.Equal(["A/Order.Audit.cs", "Z/Order.cs"], implements.Select(e => e.SourceFile).OrderBy(x => x, StringComparer.Ordinal));
        Assert.All(implements, e => Assert.Equal(e.SourceFile, e.Anchor.File));
    }

    [Fact]
    public void NestedBlockNamespacesGetALexicalParentDottedOnesDoNot()
    {
        var model = Harness.Extract(
            ("L.cs", "namespace A { public class X {} namespace B { public class Y {} } }"),
            ("D.cs", "namespace A.C { public class Z {} }"),
            ("F.cs", "namespace A.D; public class W {}")).Model;
        Assert.Equal(NaturalKey.OfModule("A"), Harness.EntityOf(model, "csharp:A.B").Parent);
        Assert.Null(Harness.EntityOf(model, "csharp:A.C").Parent);
        Assert.Null(Harness.EntityOf(model, "csharp:A.D").Parent);
    }

    [Fact]
    public void ReservedSeparatorsAreRefused()
    {
        Assert.Throws<ArgumentException>(() => new NaturalKey("a/b", ""));
        Assert.Throws<ArgumentException>(() => new NaturalKey("a", "x#y"));
        Assert.Throws<ArgumentException>(() => new NaturalKey("a", "x", "d\0"));
        Assert.Equal("csharp:m/s#d", new NaturalKey("m", "s", "d").Render());
    }

    [Fact]
    public void CanonicalOrderIsUtf16CodeUnitsWithAbsentDisambiguatorFirst()
    {
        var keys = new[]
        {
            new NaturalKey("m", "s", "z"),
            new NaturalKey("m", "s"),
            new NaturalKey("m", "ＡFullwidth"),
            new NaturalKey("m", "𠀀Supplementary"),
            new NaturalKey("m", "Ascii"),
        };
        var sorted = keys.OrderBy(k => k).Select(k => k.Render()).ToList();
        Assert.Equal(["csharp:m/Ascii", "csharp:m/s", "csharp:m/s#z", "csharp:m/𠀀Supplementary", "csharp:m/ＡFullwidth"], sorted);
    }
}
