using Codegraph.CSharp.Model;

namespace Codegraph.CSharp;

/// <summary>
/// CLI: the extractor command-line contract (schemas/README.md §8), shared with
/// the Java jar so `codegraph snapshots --extractor` can drive either:
/// <code>codegraph-csharp [--src DIR]… [--out FILE] [--progress auto|plain|none] [--repo-* …]</code>
/// Bare, it extracts the current directory into `&lt;current-dir&gt;-codegraph.jsonl`.
/// Exit codes: 0 ok · 1 failure · 2 usage · 3 unimplemented.
/// </summary>
public static class Program
{
    public const int ExitOk = 0;
    public const int ExitFailure = 1;
    public const int ExitUsage = 2;
    public const int ExitUnimplemented = 3;

    public static int Main(string[] args) => Run(args, Console.Out, Console.Error, Directory.GetCurrentDirectory());

    public static int Run(string[] args, TextWriter stdout, TextWriter stderr, string cwd)
    {
        Options options;
        try
        {
            options = Options.Parse(args, cwd);
        }
        catch (UsageException e)
        {
            stderr.WriteLine("error: " + e.Message);
            stderr.WriteLine();
            stderr.Write(Usage());
            return ExitUsage;
        }

        if (options.Help) { stdout.Write(Usage()); return ExitOk; }
        if (options.Version) { stdout.WriteLine(Extraction.Version); return ExitOk; }

        try
        {
            var progress = new Progress(options.Progress, stderr);
            var result = Extraction.Run(new ExtractOptions(options.Sources, cwd, options.Repository), progress);
            progress.Phase("write", () =>
            {
                JsonlWriter.WriteFile(result.Model, options.Out);
                return JsonlWriter.PlannedRecords(result.Model);
            }, n => $"{n:N0} records");
            stderr.Write(result.Stats.Summary(result.Model.Entities.Count, result.Stubs, result.Model.Edges.Count));
            stderr.WriteLine($"wrote {options.Out}");
            return ExitOk;
        }
        catch (UsageException e)
        {
            stderr.WriteLine("error: " + e.Message);
            return ExitUsage;
        }
        catch (NotImplementedException e)
        {
            stderr.WriteLine("error: unimplemented extraction pass: " + e.Message);
            return ExitUnimplemented;
        }
        catch (Exception e) when (e is IOException or InvalidOperationException or UnauthorizedAccessException)
        {
            stderr.WriteLine("error: " + e.Message);
            return ExitFailure;
        }
    }

    public static string Usage() =>
        $"""
        codegraph-csharp {Extraction.Version} — Roslyn-based C# extractor

        USAGE
          codegraph-csharp [--src <dir>…] [--out <file>]

        OPTIONS
          --src <dir>           source root to analyze; repeatable. Default: the current
                                directory. With several roots, anchors are relative to
                                their deepest common ancestor, which becomes the model's root.
          --out <file>          where to write the model. Default: <current-dir>-codegraph.jsonl
          --progress <mode>     auto (default: one line per phase on a terminal, nothing
                                when piped), plain, or none
          --no-progress         same as --progress none
          --repo-remote <url>   normalized https clone URL, no .git suffix
          --repo-commit <sha>   the sha this tree is at — a permalink, not a branch
          --repo-root <path>    repo-relative path of the analyzed root ("" at the repo root)
          --repo-provider <p>   github or gitlab, only when the hostname does not say
          --version             print the extractor version
          --help                this text

        No .sln or .csproj is read: every *.cs under the roots (bin/ and obj/ excluded)
        is parsed into one compilation bound against the embedded BCL. Missing
        packages become stubs. Exit codes: 0 ok, 1 failure, 2 usage, 3 unimplemented.

        """;
}

public sealed record Options(
    IReadOnlyList<string> Sources,
    string Out,
    ProgressMode Progress,
    Repository? Repository,
    bool Help,
    bool Version)
{
    public static Options Parse(string[] args, string cwd)
    {
        var sources = new List<string>();
        string? outPath = null;
        var progress = ProgressMode.Auto;
        string? remote = null, commit = null, root = null, provider = null;
        var help = false;
        var version = false;

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            string Value()
            {
                if (i + 1 >= args.Length) throw new UsageException($"{arg} needs a value");
                return args[++i];
            }
            switch (arg)
            {
                case "--src": sources.Add(Value()); break;
                case "--out": outPath = Value(); break;
                case "--progress":
                    progress = Value() switch
                    {
                        "auto" => ProgressMode.Auto,
                        "plain" => ProgressMode.Plain,
                        "none" => ProgressMode.None,
                        var other => throw new UsageException($"--progress must be auto, plain or none, got: {other}"),
                    };
                    break;
                case "--no-progress": progress = ProgressMode.None; break;
                case "--repo-remote": remote = Value(); break;
                case "--repo-commit": commit = Value(); break;
                case "--repo-root": root = Value(); break;
                case "--repo-provider": provider = Value(); break;
                case "--help" or "-h": help = true; break;
                case "--version": version = true; break;
                default: throw new UsageException($"unknown option: {arg}");
            }
        }

        Repository? repository = null;
        if (remote is not null || commit is not null || root is not null || provider is not null)
        {
            if (remote is null || commit is null || root is null)
                throw new UsageException("--repo-remote, --repo-commit and --repo-root go together (--repo-provider is optional)");
            repository = Repository.Parse(remote, commit, root, provider);
        }

        if (sources.Count == 0) sources.Add(".");
        outPath ??= Path.GetFileName(Path.TrimEndingDirectorySeparator(Path.GetFullPath(cwd))) + "-codegraph.jsonl";
        return new Options(sources, outPath, progress, repository, help, version);
    }
}
