using Codegraph.CSharp.Model;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Codegraph.CSharp;

/// <summary>Which implicit global usings the compilation gets: none, Microsoft.NET.Sdk's, or those plus the Web SDK's.</summary>
public enum ImplicitUsings { None, Sdk, Web }

/// <summary>Pass 0's result: one compilation over every `.cs` file under the roots, plus how the roots were named.</summary>
public sealed record Corpus(
    CSharpCompilation Compilation,
    IReadOnlyList<SyntaxTree> Trees,
    string RootDisplay,
    string RootFull);

/// <summary>
/// Pass 0 — the noClasspath of .NET (PLAN.md §13 principle 1): walk the source
/// roots for `*.cs`, parse each file, bind ONE compilation against the embedded
/// BCL. No `.sln`, no `.csproj`, no restore: a missing package is a stub, not a
/// build failure. `bin/` and `obj/` are skipped — they hold build output
/// (generated `AssemblyInfo.cs`, `GlobalUsings.g.cs`), never sources.
/// </summary>
public static class CorpusLoader
{
    private static readonly string[] SkippedDirectories = ["bin", "obj"];

    /// <summary>The path of the synthetic implicit-usings tree; never a corpus file, never anchored, never walked for edges.</summary>
    public const string ImplicitUsingsPath = "<implicit-usings>";

    /// <summary>
    /// What `&lt;ImplicitUsings&gt;enable&lt;/ImplicitUsings&gt;` makes the SDK
    /// generate into obj/ (skipped, being build output) for every modern
    /// project. Without them `Task`, `List&lt;T&gt;` and `CancellationToken` in a
    /// file with no `using` of its own bind to nothing: measured on OrchardCore,
    /// they were the four most-referenced "unresolved" names. An import edge is
    /// never written for them — no file wrote them.
    ///
    /// The DEFAULT is Microsoft.NET.Sdk's seven. The Web SDK's additions are
    /// opt-in (`--implicit-usings web`): one compilation cannot apply them per
    /// project, and on a corpus that is not all Web-SDK they make names
    /// ambiguous — OrchardCore's own `StartupBase` collided 345 times with
    /// `Microsoft.AspNetCore.Hosting.StartupBase` before this was measured.
    /// </summary>
    public static readonly string[] SdkImplicitUsings =
    [
        "System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks",
    ];

    public static readonly string[] WebSdkImplicitUsings =
    [
        "System.Net.Http.Json", "Microsoft.AspNetCore.Builder", "Microsoft.AspNetCore.Hosting", "Microsoft.AspNetCore.Http", "Microsoft.AspNetCore.Routing",
        "Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging",
    ];

    public static IReadOnlyList<string> ImplicitUsingsFor(ImplicitUsings mode) =>
        mode switch
        {
            ImplicitUsings.None => [],
            ImplicitUsings.Sdk => SdkImplicitUsings,
            ImplicitUsings.Web => [.. SdkImplicitUsings, .. WebSdkImplicitUsings],
            _ => throw new ArgumentOutOfRangeException(nameof(mode)),
        };

    public static Corpus Load(IReadOnlyList<string> sourcesAsTyped, string baseDirectory, Progress progress, ImplicitUsings implicitUsings = ImplicitUsings.Sdk)
    {
        if (sourcesAsTyped.Count == 0) throw new ArgumentException("at least one --src is required", nameof(sourcesAsTyped));

        var fullSources = new List<string>(sourcesAsTyped.Count);
        foreach (var typed in sourcesAsTyped)
        {
            var full = Path.GetFullPath(Path.Combine(baseDirectory, typed));
            if (!Directory.Exists(full) && !File.Exists(full))
                throw new UsageException($"--src {typed}: no such file or directory");
            fullSources.Add(full);
        }
        var directories = fullSources.Select(s => Directory.Exists(s) ? s : Path.GetDirectoryName(s)!).ToList();
        var rootFull = Paths.CommonRoot(directories);
        var rootDisplay = sourcesAsTyped.Count == 1 ? Paths.Display(sourcesAsTyped[0]) : Paths.Slashes(rootFull);

        var files = progress.Phase("walk", () =>
        {
            var found = new SortedDictionary<string, string>(StringComparer.Ordinal);
            foreach (var source in fullSources)
            {
                if (File.Exists(source)) { found[Paths.Relative(rootFull, source)] = source; continue; }
                foreach (var file in Walk(source)) found[Paths.Relative(rootFull, file)] = file;
            }
            return found.ToList();
        }, list => $"{list.Count:N0} files");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest, DocumentationMode.Parse);
        var trees = progress.Phase("parse", () =>
        {
            var parsed = new List<SyntaxTree>(files.Count + 1);
            foreach (var (relative, full) in files)
            {
                var text = File.ReadAllText(full);
                parsed.Add(CSharpSyntaxTree.ParseText(text, parseOptions, path: relative));
            }
            var usings = ImplicitUsingsFor(implicitUsings);
            if (usings.Count > 0)
            {
                var source = string.Concat(usings.Select(ns => $"global using {ns};\n"));
                parsed.Add(CSharpSyntaxTree.ParseText(source, parseOptions, path: ImplicitUsingsPath));
            }
            return parsed;
        }, list => $"{list.Count(t => t.FilePath != ImplicitUsingsPath):N0} files");

        var compilation = progress.Phase("bind", () =>
            CSharpCompilation.Create(
                "corpus",
                trees,
                ReferenceAssemblies.All,
                new CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    allowUnsafe: true,
                    nullableContextOptions: NullableContextOptions.Enable)),
            _ => $"{ReferenceAssemblies.Count:N0} reference assemblies");

        return new Corpus(compilation, trees, rootDisplay, rootFull);
    }

    private static IEnumerable<string> Walk(string directory)
    {
        foreach (var file in Directory.EnumerateFiles(directory))
            if (file.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) yield return file;
        foreach (var sub in Directory.EnumerateDirectories(directory))
        {
            var name = Path.GetFileName(sub);
            if (SkippedDirectories.Contains(name, StringComparer.OrdinalIgnoreCase)) continue;
            foreach (var file in Walk(sub)) yield return file;
        }
    }
}
