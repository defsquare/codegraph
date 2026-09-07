using System.Text.Json;
using System.Text.Json.Nodes;
using Json.Schema;

namespace Codegraph.CSharp.Tests;

/// <summary>
/// The output validated against the PUBLISHED contract — `schemas/*.record.schema.json`
/// per line, and the sequence rules of `schemas/README.md` that a line-at-a-time
/// validator cannot see: section order, dense surrogates, dictionary bounds,
/// the trait/key table, closure, counts. Steps 1 and 3–5 of §7, in the
/// extractor's own language, using nothing but the schemas directory.
/// </summary>
public class ModelSchemaValidationTest
{
    private static readonly string[] Sections = ["header", "f", "e", "x", "eof"];

    private static readonly Dictionary<string, JsonSchema> Schemas = Sections.ToDictionary(
        t => t,
        t => JsonSchema.FromFile(Path.Combine(Harness.RepoRoot, "schemas", $"{t}.record.schema.json")),
        StringComparer.Ordinal);

    /// <summary>§4 of the contract: the keys each trait contributes, restated verbatim.</summary>
    private static readonly Dictionary<string, string[]> TraitKeys = new(StringComparer.Ordinal)
    {
        ["TNamed"] = ["name"],
        ["TSourceAnchor"] = ["anchor"],
        ["TComment"] = ["comments"],
        ["TWithChildren"] = [],
        ["TChildOf"] = ["parent"],
        ["TAttachedTo"] = ["attachedTo"],
        ["TModule"] = ["definedIn", "isStub"],
        ["TType"] = ["isStub"],
        ["TWithInheritances"] = [],
        ["TWithImplements"] = [],
        ["TTypedEntity"] = ["declaredType"],
        ["TInvocable"] = ["signature"],
        ["TWithParameters"] = ["parameters"],
        ["TWithLocalVariables"] = ["localVariables"],
        ["TWithInvocations"] = [],
        ["TStructural"] = [],
        ["TWithAccesses"] = [],
        ["TMetrics"] = ["metrics"],
        ["TWithValue"] = ["value"],
    };

    private static readonly string[] OptionalValued = ["declaredType"];

    private static readonly string[] RecordKeys = ["t", "i", "k", "tr", "m", "s", "d"];

    private static List<JsonObject> Lines() =>
        Harness.FixtureJsonl.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonNode.Parse(line)!.AsObject())
            .ToList();

    [Fact]
    public void EveryLineValidatesAgainstTheSchemaForItsType()
    {
        var options = new EvaluationOptions { OutputFormat = OutputFormat.List };
        var failures = new List<string>();
        foreach (var (line, index) in Lines().Select((l, i) => (l, i)))
        {
            var t = line["t"]!.GetValue<string>();
            Assert.Contains(t, Schemas.Keys);
            using var document = JsonDocument.Parse(line.ToJsonString());
            var result = Schemas[t].Evaluate(document.RootElement, options);
            if (!result.IsValid)
            {
                var errors = (result.Details ?? []).Where(d => d.Errors is { Count: > 0 }).SelectMany(d => d.Errors!.Select(e => $"{d.InstanceLocation}: {e.Value}"));
                failures.Add($"line {index + 1} ({t}): {string.Join("; ", errors)}\n    {line.ToJsonString()}");
            }
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    [Fact]
    public void SectionsAreOrderedAndSurrogatesDense()
    {
        var lines = Lines();
        Assert.Equal("header", lines[0]["t"]!.GetValue<string>());
        Assert.Equal("eof", lines[^1]["t"]!.GetValue<string>());
        var rank = 0;
        int files = 0, entities = 0, edges = 0;
        foreach (var line in lines)
        {
            var t = line["t"]!.GetValue<string>();
            var r = Array.IndexOf(Sections, t);
            Assert.True(r >= rank, $"{t} after a later section");
            rank = r;
            switch (t)
            {
                case "f": Assert.Equal(files++, line["i"]!.GetValue<int>()); break;
                case "e": Assert.Equal(entities++, line["i"]!.GetValue<int>()); break;
                case "x": edges++; break;
            }
        }
        var counts = lines[^1]["counts"]!;
        Assert.Equal(files, counts["files"]!.GetValue<int>());
        Assert.Equal(entities, counts["entities"]!.GetValue<int>());
        Assert.Equal(edges, counts["edges"]!.GetValue<int>());
        Assert.Equal(1, lines.Count(l => l["t"]!.GetValue<string>() == "header"));
        Assert.Equal(1, lines.Count(l => l["t"]!.GetValue<string>() == "eof"));
    }

    [Fact]
    public void DictionariesResolveAndTraitKeysMatchDeclaredTraits()
    {
        var lines = Lines();
        var dict = lines[0]["dict"]!;
        var kinds = dict["kinds"]!.AsArray().Select(k => k!.GetValue<string>()).ToList();
        var traits = dict["traits"]!.AsArray().Select(k => k!.GetValue<string>()).ToList();
        var edgeKinds = dict["edges"]!.AsArray().Select(k => k!.GetValue<string>()).ToList();
        var provenance = dict["provenance"]!.AsArray().Select(k => k!.GetValue<string>()).ToList();
        foreach (var list in new[] { kinds, traits, edgeKinds, provenance })
            Assert.Equal(list.OrderBy(x => x, StringComparer.Ordinal), list);

        var entityCount = lines[^1]["counts"]!["entities"]!.GetValue<int>();
        var fileCount = lines[^1]["counts"]!["files"]!.GetValue<int>();
        foreach (var line in lines.Where(l => l["t"]!.GetValue<string>() == "e"))
        {
            Assert.InRange(line["k"]!.GetValue<int>(), 0, kinds.Count - 1);
            var declared = line["tr"]!.AsArray().Select(i => traits[i!.GetValue<int>()]).ToHashSet(StringComparer.Ordinal);
            Assert.InRange(line["m"]!.GetValue<int>(), 0, line["i"]!.GetValue<int>());
            var contributed = declared.SelectMany(t => TraitKeys[t]).ToHashSet(StringComparer.Ordinal);
            var present = line.Select(p => p.Key).Where(k => !RecordKeys.Contains(k)).ToHashSet(StringComparer.Ordinal);
            foreach (var key in present)
                Assert.True(contributed.Contains(key), $"entity {line["i"]}: `{key}` present without its trait ({string.Join(",", declared)})");
            foreach (var key in contributed.Except(OptionalValued))
                Assert.True(present.Contains(key), $"entity {line["i"]}: `{key}` missing though its trait is declared");
            // Closure and path bounds on every reference.
            foreach (var key in new[] { "parent", "attachedTo", "declaredType" })
                if (line[key] is { } v) Assert.InRange(v.GetValue<int>(), 0, entityCount - 1);
            foreach (var key in new[] { "parameters", "localVariables" })
                if (line[key] is { } v) foreach (var r in v.AsArray()) Assert.InRange(r!.GetValue<int>(), 0, entityCount - 1);
            if (line["definedIn"] is { } d) foreach (var f in d.AsArray()) Assert.InRange(f!.GetValue<int>(), 0, fileCount - 1);
            if (line["anchor"] is { } a)
            {
                Assert.InRange(a[0]!.GetValue<int>(), 0, fileCount - 1);
                Assert.True(a[1]!.GetValue<int>() >= 1 && a[2]!.GetValue<int>() >= a[1]!.GetValue<int>());
            }
        }
        foreach (var line in lines.Where(l => l["t"]!.GetValue<string>() == "x"))
        {
            Assert.InRange(line["k"]!.GetValue<int>(), 0, edgeKinds.Count - 1);
            Assert.InRange(line["p"]!.GetValue<int>(), 0, provenance.Count - 1);
            var f = line["f"]!.GetValue<int>();
            var o = line["o"]!.GetValue<int>();
            Assert.InRange(f, 0, entityCount - 1);
            Assert.InRange(o, 0, entityCount - 1);
            Assert.NotEqual(f, o);
            Assert.InRange(line["anchor"]![0]!.GetValue<int>(), 0, fileCount - 1);
        }
    }

    [Fact]
    public void HeaderNamesThisExtractorAndItsVersion()
    {
        var header = Lines()[0];
        Assert.Equal("csharp", header["lang"]!.GetValue<string>());
        Assert.Equal(Extraction.Name, header["extractor"]!["name"]!.GetValue<string>());
        Assert.Equal(Extraction.Version, header["extractor"]!["version"]!.GetValue<string>());
        Assert.True(header["extractor"]!["noMsBuild"]!.GetValue<bool>());
        Assert.Matches("^[0-9]+\\.[0-9]+\\.[0-9]+$", Extraction.Version);
    }
}
