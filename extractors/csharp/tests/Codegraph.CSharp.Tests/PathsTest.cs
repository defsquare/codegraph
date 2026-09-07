namespace Codegraph.CSharp.Tests;

/// <summary>PLAN.md §13.8: `/` on every OS, root-relative, the deepest common ancestor as root.</summary>
public class PathsTest
{
    [Fact]
    public void BackslashesBecomeSlashes()
    {
        Assert.Equal("a/b/c.cs", Paths.Slashes("a\\b/c.cs"));
    }

    [Fact]
    public void DisplayTrimsTrailingSeparatorsAndKeepsTheTypedForm()
    {
        Assert.Equal("fixtures/csharp/src", Paths.Display("fixtures/csharp/src/"));
        Assert.Equal("fixtures/csharp/src", Paths.Display("fixtures\\csharp\\src"));
        Assert.Equal(".", Paths.Display("./"));
        Assert.Equal("/", Paths.Display("/"));
    }

    [Fact]
    public void RelativePathsNeverEscapeTheRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "cg-root");
        Assert.Equal("x/y.cs", Paths.Relative(root, Path.Combine(root, "x", "y.cs")));
        Assert.Throws<InvalidOperationException>(() => Paths.Relative(root, Path.Combine(Path.GetTempPath(), "elsewhere.cs")));
    }

    [Fact]
    public void CommonRootIsTheDeepestSharedAncestor()
    {
        var tmp = Path.GetFullPath(Path.GetTempPath());
        var a = Path.Combine(tmp, "cg", "a", "src");
        var b = Path.Combine(tmp, "cg", "b");
        Assert.Equal(Path.Combine(tmp, "cg"), Paths.CommonRoot([a, b]));
        Assert.Equal(a, Paths.CommonRoot([a]));
        Assert.Equal(a, Paths.CommonRoot([a, Path.Combine(a, "deeper")]));
    }

    [Fact]
    public void AnchorsInTheFixtureAreRootRelativeWithSlashes()
    {
        foreach (var entity in Harness.FixtureModel.Entities)
        {
            if (entity.Anchor is null) continue;
            Assert.DoesNotContain('\\', entity.Anchor.File);
            Assert.False(Path.IsPathRooted(entity.Anchor.File), entity.Anchor.File);
            Assert.StartsWith("Acme/", entity.Anchor.File, StringComparison.Ordinal);
        }
    }
}
