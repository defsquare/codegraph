namespace Codegraph.CSharp.Tests;

/// <summary>
/// The committed snapshot IS the cross-OS contract (PLAN.md §13 principle 3):
/// the same bytes from this run, from the published binary on another host,
/// and from core's own encoder. `CODEGRAPH_UPDATE_SNAPSHOT=1` regenerates it
/// deliberately; the diff is then reviewed like any other change.
/// </summary>
public class SnapshotTest
{
    [Fact]
    public void FixtureExtractsToTheCommittedSnapshot()
    {
        var actual = Harness.FixtureJsonl;
        var path = Path.Combine(Harness.RepoRoot, Harness.SnapshotPath);
        if (Environment.GetEnvironmentVariable("CODEGRAPH_UPDATE_SNAPSHOT") == "1")
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, actual);
        }
        Assert.True(File.Exists(path), $"no snapshot at {path} — run with CODEGRAPH_UPDATE_SNAPSHOT=1 to create it");
        var expected = File.ReadAllText(path);
        if (expected != actual)
        {
            var expectedLines = expected.Split('\n');
            var actualLines = actual.Split('\n');
            var firstDiff = Enumerable.Range(0, Math.Max(expectedLines.Length, actualLines.Length))
                .First(i => i >= expectedLines.Length || i >= actualLines.Length || expectedLines[i] != actualLines[i]);
            Assert.Fail(
                $"snapshot differs from extraction at line {firstDiff + 1}:\n" +
                $"  expected: {(firstDiff < expectedLines.Length ? expectedLines[firstDiff] : "<eof>")}\n" +
                $"  actual:   {(firstDiff < actualLines.Length ? actualLines[firstDiff] : "<eof>")}\n" +
                "Regenerate deliberately with CODEGRAPH_UPDATE_SNAPSHOT=1 and review the diff.");
        }
    }

    [Fact]
    public void SnapshotRootIsTheTypedPath()
    {
        Assert.Equal(Harness.FixtureRoot, Harness.FixtureModel.Root);
    }
}
