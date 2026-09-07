using System.Collections.Immutable;
using System.Reflection;
using Microsoft.CodeAnalysis;

namespace Codegraph.CSharp;

/// <summary>
/// The BCL as metadata images embedded in this assembly (the SDK's own
/// `Microsoft.NETCore.App.Ref` pack, see the csproj). Loaded from resources,
/// never from <c>Assembly.Location</c>: inside a single-file bundle that
/// property is the empty string, so a binary built the tutorial way binds
/// nothing in production while passing under <c>dotnet run</c> (PLAN.md §13.1).
/// </summary>
public static class ReferenceAssemblies
{
    private static readonly Lazy<ImmutableArray<MetadataReference>> Loaded = new(Load);

    public static ImmutableArray<MetadataReference> All => Loaded.Value;

    public static int Count => All.Length;

    private static ImmutableArray<MetadataReference> Load()
    {
        var assembly = typeof(ReferenceAssemblies).Assembly;
        var names = assembly.GetManifestResourceNames()
            .Where(n => n.StartsWith("ref/", StringComparison.Ordinal))
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        if (names.Count == 0)
            throw new InvalidOperationException("no embedded BCL reference assemblies — the build did not embed the targeting pack");
        var references = ImmutableArray.CreateBuilder<MetadataReference>(names.Count);
        foreach (var name in names)
        {
            using var stream = assembly.GetManifestResourceStream(name)
                ?? throw new InvalidOperationException($"embedded resource vanished: {name}");
            using var buffer = new MemoryStream();
            stream.CopyTo(buffer);
            references.Add(MetadataReference.CreateFromImage(buffer.ToArray(), filePath: name["ref/".Length..]));
        }
        return references.ToImmutable();
    }
}
