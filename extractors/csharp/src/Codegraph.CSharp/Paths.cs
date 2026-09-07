namespace Codegraph.CSharp;

/// <summary>
/// Paths as the model writes them: `/`-separated on every OS, root-relative,
/// compared ordinally. The file table is sorted by these strings, and a
/// Windows `\` or a case-folding comparison would change every surrogate.
/// </summary>
public static class Paths
{
    public static string Slashes(string path) => path.Replace('\\', '/');

    /// <summary>The typed path with `/` separators and no trailing slash — what the header's `root` shows.</summary>
    public static string Display(string typed)
    {
        var s = Slashes(typed);
        while (s.Length > 1 && s.EndsWith('/')) s = s[..^1];
        return s.Length == 0 ? "." : s;
    }

    public static string Relative(string rootFull, string fileFull)
    {
        var relative = Path.GetRelativePath(rootFull, fileFull);
        if (relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative))
            throw new InvalidOperationException($"{fileFull} is not under {rootFull}");
        return Slashes(relative);
    }

    /// <summary>Deepest common ancestor of absolute directory paths — METAMODEL.md §8: one root, no absolute anchor.</summary>
    public static string CommonRoot(IReadOnlyList<string> fullDirectories)
    {
        if (fullDirectories.Count == 0) throw new ArgumentException("at least one source root is required", nameof(fullDirectories));
        var common = Path.GetFullPath(fullDirectories[0]);
        foreach (var candidate in fullDirectories.Skip(1))
        {
            var full = Path.GetFullPath(candidate);
            while (!IsUnder(full, common))
            {
                var parent = Path.GetDirectoryName(common);
                if (parent is null) return Path.GetPathRoot(common) ?? "/";
                common = parent;
            }
        }
        return common;
    }

    private static bool IsUnder(string full, string root)
    {
        var rootWithSeparator = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
        return full == root || full.StartsWith(rootWithSeparator, StringComparison.Ordinal);
    }
}
