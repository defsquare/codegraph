using Codegraph.CSharp.Model;

namespace Codegraph.CSharp.Tests;

/// <summary>
/// Measures hand-counted over sources written for them (METAMODEL §3.8): the
/// numbers below are checkable by reading the source, which is the point.
/// </summary>
public class MeasuresTest
{
    private static double Measure(ExtractedModel model, string id, string key) =>
        Harness.EntityOf(model, id).Metrics![key];

    [Fact]
    public void CyclomaticCountsEveryBranchKindOnce()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class A {
                public int Run(int x, int? y, object o) {
                  if (x > 0 && y != null || o == null) x++;          // if, &&, ||  -> +3
                  for (var i = 0; i < 2; i++) {}                      // for         -> +1
                  foreach (var c in "ab") {}                          // foreach     -> +1
                  while (x < 0) x++;                                  // while       -> +1
                  do { x--; } while (x > 10);                         // do          -> +1
                  switch (x) { case 1: break; case 2 when y > 0: break; default: break; }  // 2 cases + when -> +3
                  var s = x switch { 1 => "a", 2 => "b", _ => "c" }; // 2 arms (discard is default) -> +2
                  try { x = y ?? 0; } catch (System.Exception) {}     // ??, catch  -> +2
                  x = x > 0 ? 1 : 2;                                  // ternary    -> +1
                  return o is int n ? n : x;                          // ternary    -> +1
                }
              }
            }
            """)).Model;
        Assert.Equal(1 + 3 + 1 + 1 + 1 + 1 + 3 + 2 + 2 + 1 + 1, Measure(model, "csharp:N/A.Run(System.Int32,System.Nullable`1,System.Object)", "cyclomatic"));
    }

    [Fact]
    public void ANestedLambdaOrLocalFunctionKeepsItsOwnBranches()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class A {
                public int Run(int x) {
                  System.Func<int, int> f = v => v > 0 ? v : -v;
                  int Local(int v) { if (v > 1) return 1; return 0; }
                  return f(x) + Local(x);
                }
              }
            }
            """)).Model;
        Assert.Equal(1, Measure(model, "csharp:N/A.Run(System.Int32)", "cyclomatic"));
        Assert.Equal(2, Measure(model, "csharp:N/A#A.cs:4:33", "cyclomatic"));
        Assert.Equal(2, Measure(model, "csharp:N/A.Run(System.Int32)#fn:Local(System.Int32)", "cyclomatic"));
    }

    [Fact]
    public void SlocCountsLinesWithTokensNeitherBlankNorCommentOnly()
    {
        var model = Harness.Extract(("A.cs", """
            namespace N {
              public class A {
                /// <summary>Doc.</summary>
                public int Run()
                {
                    // a comment-only line

                    var s = @"a
            b";
                    return s.Length; /* trailing */
                }
              }
            }
            """)).Model;
        // Lines with a token: signature, `{`, `var s = @"a`, `b";`, `return …`, `}` = 6;
        // the class adds its own header and closing brace = 8. The doc comment,
        // the comment-only line and the blank line count for neither.
        Assert.Equal(6, Measure(model, "csharp:N/A.Run()", "sloc"));
        Assert.Equal(8, Measure(model, "csharp:N/A", "sloc"));
    }

    [Fact]
    public void FixtureMeasuresAreHandCounted()
    {
        var model = Harness.FixtureModel;
        // Reporting.Max: foreach + `if (best == null || …)` → 1 + 1 + 1 + 1.
        Assert.Equal(4, Measure(model, "csharp:Acme.Order/Reporting.Max`1(System.Collections.Generic.List`1)", "cyclomatic"));
        Assert.Equal(2, Measure(model, "csharp:Acme.Order/Reporting.Join(System.String[])", "cyclomatic"));
        Assert.Equal(2, Measure(model, "csharp:Acme.Order/Reporting.First`1(System.Collections.Generic.List`1)", "cyclomatic"));
        Assert.Equal(1, Measure(model, "csharp:Acme.Order/Reporting.Today()", "cyclomatic"));
        // Describe: a switch expression with two non-discard arms.
        Assert.Equal(3, Measure(model, "csharp:Acme.Order/Reporting.Describe(Acme.Order.Channel)", "cyclomatic"));
        // StockGuard.Ensure: a guard `if` and one `catch`.
        Assert.Equal(3, Measure(model, "csharp:Acme.Order/StockGuard.Ensure(System.Int32)", "cyclomatic"));
    }

    [Fact]
    public void EveryMeasureIsFiniteNonNegativeAndSlocWithinTheSpan()
    {
        foreach (var entity in Harness.FixtureModel.Entities)
        {
            if (entity.Metrics is null) { Assert.False(entity.Has(Traits.TMetrics)); continue; }
            Assert.True(entity.Has(Traits.TMetrics));
            foreach (var (_, value) in entity.Metrics) Assert.True(double.IsFinite(value) && value >= 0);
            if (entity.Metrics.TryGetValue("sloc", out var sloc))
                Assert.True(sloc <= entity.Anchor!.EndLine - entity.Anchor.StartLine + 1, entity.Key.Render());
            Assert.NotEqual(true, entity.IsStub);
        }
    }
}
