using Codegraph.CSharp.Model;

namespace Codegraph.CSharp.Tests;

/// <summary>Contract §6: two runs over one unchanged corpus produce byte-identical files.</summary>
public class DeterminismTest
{
    [Fact]
    public void TwoRunsOverTheFixtureAreByteIdentical()
    {
        var first = JsonlWriter.Write(Extraction.Run(new ExtractOptions([Harness.FixtureRoot], Harness.RepoRoot), Progress.Silent).Model);
        var second = JsonlWriter.Write(Extraction.Run(new ExtractOptions([Harness.FixtureRoot], Harness.RepoRoot), Progress.Silent).Model);
        Assert.Equal(first, second);
    }

    [Fact]
    public void FileWalkOrderDoesNotReachTheBytes()
    {
        // The same two files written in the two possible orders; the file table
        // and every surrogate must come out the same.
        var a = ("Z.cs", "namespace N { public class Z : A {} }");
        var b = ("A.cs", "namespace N { public class A {} }");
        var forward = JsonlWriter.Write(Harness.Extract(a, b).Model);
        var backward = JsonlWriter.Write(Harness.Extract(b, a).Model);
        Assert.Equal(forward, backward);
        Assert.Contains("\"t\":\"f\",\"i\":0,\"path\":\"A.cs\"", forward, StringComparison.Ordinal);
    }

    [Fact]
    public void CrlfSourcesGiveTheSameLinesAsLfSources()
    {
        const string source = "namespace N;\n\n/// <summary>Doc.</summary>\npublic class C\n{\n}\n";
        var lf = JsonlWriter.Write(Harness.Extract(("C.cs", source)).Model);
        var crlf = JsonlWriter.Write(Harness.Extract(("C.cs", source.Replace("\n", "\r\n", StringComparison.Ordinal))).Model);
        Assert.Equal(lf, crlf);
        Assert.Contains("\"anchor\":[0,4,6]", lf, StringComparison.Ordinal);
    }

    [Fact]
    public void LinesAreLfTerminatedAndUtf8WithoutBom()
    {
        var path = Path.Combine(Path.GetTempPath(), "codegraph-csharp-" + Guid.NewGuid().ToString("n") + ".jsonl");
        try
        {
            JsonlWriter.WriteFile(Harness.FixtureModel, path);
            var bytes = File.ReadAllBytes(path);
            Assert.NotEqual(0xEF, bytes[0]);
            Assert.DoesNotContain((byte)'\r', bytes);
            Assert.Equal((byte)'\n', bytes[^1]);
            Assert.Equal(Harness.FixtureJsonl, File.ReadAllText(path));
        }
        finally
        {
            File.Delete(path);
        }
    }
}
