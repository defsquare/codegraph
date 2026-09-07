using Codegraph.CSharp.Model;

namespace Codegraph.CSharp.Tests;

/// <summary>The extractor command-line contract (schemas/README.md §8), shared with the Java jar.</summary>
public class CliTest
{
    private static (int Code, string Out, string Err) Run(string cwd, params string[] args)
    {
        var stdout = new StringWriter();
        var stderr = new StringWriter();
        var code = Program.Run(args, stdout, stderr, cwd);
        return (code, stdout.ToString(), stderr.ToString());
    }

    [Fact]
    public void HelpAndVersionExitZeroOnStdout()
    {
        var help = Run(Harness.RepoRoot, "--help");
        Assert.Equal(Program.ExitOk, help.Code);
        Assert.Contains("--src <dir>", help.Out, StringComparison.Ordinal);
        Assert.Equal("", help.Err);
        var version = Run(Harness.RepoRoot, "--version");
        Assert.Equal(Program.ExitOk, version.Code);
        Assert.Equal(Extraction.Version + "\n", version.Out.Replace("\r\n", "\n", StringComparison.Ordinal));
    }

    [Fact]
    public void UnknownOptionsAndBadValuesAreUsageErrors()
    {
        Assert.Equal(Program.ExitUsage, Run(Harness.RepoRoot, "--bogus").Code);
        Assert.Equal(Program.ExitUsage, Run(Harness.RepoRoot, "--src").Code);
        Assert.Equal(Program.ExitUsage, Run(Harness.RepoRoot, "--progress", "loud").Code);
        Assert.Equal(Program.ExitUsage, Run(Harness.RepoRoot, "--src", "no/such/dir", "--out", Path.GetTempFileName()).Code);
        Assert.Equal(Program.ExitUsage, Run(Harness.RepoRoot, "--repo-remote", "https://github.com/a/b").Code);
        var badSha = Run(Harness.RepoRoot, "--repo-remote", "https://github.com/a/b", "--repo-commit", "main", "--repo-root", "");
        Assert.Equal(Program.ExitUsage, badSha.Code);
        Assert.Contains("--repo-commit", badSha.Err, StringComparison.Ordinal);
    }

    [Fact]
    public void DefaultsExtractTheCurrentDirectoryIntoANamedFile()
    {
        var options = Options.Parse([], "/tmp/my-corpus");
        Assert.Equal(["."], options.Sources);
        Assert.Equal("my-corpus-codegraph.jsonl", options.Out);
        Assert.Equal(ProgressMode.Auto, options.Progress);
        Assert.Null(options.Repository);
    }

    [Fact]
    public void RepositoryFactsAreCopiedVerbatimIntoTheHeader()
    {
        var options = Options.Parse(
            ["--repo-remote", "https://gitlab.example.com/acme/orders", "--repo-commit", "0123abcd", "--repo-root", "src/main", "--repo-provider", "gitlab"],
            "/tmp");
        Assert.Equal(new Repository("https://gitlab.example.com/acme/orders", "0123abcd", "src/main", "gitlab"), options.Repository);
    }

    [Fact]
    public void ARealRunWritesTheSnapshotBytesAndSummarizesOnStderr()
    {
        var outPath = Path.Combine(Path.GetTempPath(), "codegraph-csharp-" + Guid.NewGuid().ToString("n") + ".jsonl");
        try
        {
            var run = Run(Harness.RepoRoot, "--src", Harness.FixtureRoot, "--out", outPath, "--progress", "plain");
            Assert.Equal(Program.ExitOk, run.Code);
            Assert.Equal("", run.Out);
            Assert.Contains("RESOLUTION SUMMARY", run.Err, StringComparison.Ordinal);
            Assert.Contains("✓ parse", run.Err, StringComparison.Ordinal);
            Assert.Equal(Harness.FixtureJsonl, File.ReadAllText(outPath));
        }
        finally
        {
            File.Delete(outPath);
        }
    }
}
