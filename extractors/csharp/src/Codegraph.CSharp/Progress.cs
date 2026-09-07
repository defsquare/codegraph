using System.Diagnostics;
using System.Globalization;

namespace Codegraph.CSharp;

public enum ProgressMode { Auto, Plain, None }

/// <summary>
/// One line per phase on stderr (`--progress plain`), nothing when piped
/// (`auto` while stderr is not a terminal) or silenced. stderr is a read
/// format here — the summary lands on it — so a redirected run is
/// byte-identical to one without progress at all.
/// </summary>
public sealed class Progress(ProgressMode mode, TextWriter err)
{
    private readonly bool enabled = mode == ProgressMode.Plain || (mode == ProgressMode.Auto && !Console.IsErrorRedirected);

    public static Progress Silent { get; } = new(ProgressMode.None, TextWriter.Null);

    public T Phase<T>(string name, Func<T> work, Func<T, string> detail)
    {
        var watch = Stopwatch.StartNew();
        var result = work();
        if (enabled)
        {
            var seconds = (watch.Elapsed.TotalSeconds).ToString("0.0", CultureInfo.InvariantCulture);
            err.WriteLine($"✓ {name,-10} {detail(result)}  {seconds}s");
        }
        return result;
    }
}
