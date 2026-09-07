using System.Text;

namespace Codegraph.CSharp.Model;

/// <summary>
/// The model → `model.jsonl`, exactly as core's own encoder would write it:
/// canonical entity order IS the surrogate assignment, file paths interned and
/// sorted, dictionaries sorted, edges sorted by `(f, o, kind, anchor, provenance)`,
/// one LF-terminated line per record, `eof` counts last. Every reference is
/// resolved to a surrogate here, so a dangling one is unwritable: it throws.
/// </summary>
public static class JsonlWriter
{
    public const string SchemaVersion = "1.0.0";

    public static string Write(ExtractedModel model)
    {
        var sb = new StringBuilder();
        foreach (var line in Lines(model)) sb.Append(line).Append('\n');
        return sb.ToString();
    }

    public static void WriteFile(ExtractedModel model, string path)
    {
        using var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None);
        using var writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        writer.NewLine = "\n";
        foreach (var line in Lines(model)) writer.Write(line + "\n");
    }

    /// <summary>The planned record count, for a progress bar that claims a total only once measured.</summary>
    public static int PlannedRecords(ExtractedModel model) =>
        2 + Paths(model).Count + model.Entities.Count + model.Edges.Count;

    public static IEnumerable<string> Lines(ExtractedModel model)
    {
        // 1. Canonical order and uniqueness.
        var entities = model.Entities.OrderBy(e => e.Key).ToList();
        var surrogate = new Dictionary<NaturalKey, int>(entities.Count);
        for (var i = 0; i < entities.Count; i++)
        {
            entities[i].Validate();
            if (!surrogate.TryAdd(entities[i].Key, i))
                throw new InvalidOperationException($"duplicate natural key: {entities[i].Key}");
        }

        // 2. Modules by path — a module names itself.
        var moduleSurrogate = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < entities.Count; i++)
            if (entities[i].Key.IsModule) moduleSurrogate.TryAdd(entities[i].Key.Module, i);

        int Ref(NaturalKey key, string from) =>
            surrogate.TryGetValue(key, out var index)
                ? index
                : throw new InvalidOperationException($"{from} references an entity this model does not declare: {key}");

        // 3. File table.
        var files = Paths(model);
        var fileIndex = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < files.Count; i++) fileIndex[files[i]] = i;
        int File(string path) => fileIndex[path];

        // 4. Dictionaries: what this model uses, sorted.
        var kinds = Dict(entities.Select(e => e.Kind));
        var traits = Dict(entities.SelectMany(e => e.Traits));
        var edgeKinds = Dict(model.Edges.Select(e => e.Kind));
        var provenance = Dict(model.Edges.Select(e => e.Provenance));

        var header = new JsonLine().BeginObject()
            .Key("t").Str("header")
            .Key("schemaVersion").Str(SchemaVersion)
            .Key("lang").Str(NaturalKey.Lang)
            .Key("extractor").BeginObject()
                .Key("name").Str(model.Extractor.Name)
                .Key("version").Str(model.Extractor.Version)
                .Key("noMsBuild").Bool(true)
            .EndObject()
            .Key("root").Str(model.Root);
        if (model.Repository is { } repo)
        {
            header.Key("repository").BeginObject()
                .Key("remote").Str(repo.Remote)
                .Key("commit").Str(repo.Commit)
                .Key("root").Str(repo.Root);
            if (repo.Provider is not null) header.Key("provider").Str(repo.Provider);
            header.EndObject();
        }
        header.Key("dict").BeginObject()
            .Key("kinds").Strs(kinds)
            .Key("traits").Strs(traits)
            .Key("edges").Strs(edgeKinds)
            .Key("provenance").Strs(provenance)
        .EndObject().EndObject();
        yield return header.ToString();

        for (var i = 0; i < files.Count; i++)
            yield return new JsonLine().BeginObject().Key("t").Str("f").Key("i").Int(i).Key("path").Str(files[i]).EndObject().ToString();

        var kindIndex = Index(kinds);
        var traitIndex = Index(traits);
        for (var i = 0; i < entities.Count; i++)
        {
            var e = entities[i];
            var key = e.Key;
            if (!moduleSurrogate.TryGetValue(key.Module, out var m))
                throw new InvalidOperationException($"entity {key} names module \"{key.Module}\", which declares no module entity");
            var line = new JsonLine().BeginObject()
                .Key("t").Str("e")
                .Key("i").Int(i)
                .Key("k").Int(kindIndex[e.Kind])
                .Key("tr").Ints(e.Traits.Select(t => traitIndex[t]))
                .Key("m").Int(m)
                .Key("s").Str(i == m ? key.Module : key.Symbol);
            if (key.Disambiguator is not null) line.Key("d").Str(key.Disambiguator);
            // ENTITY_KEY_ORDER in core's encoder — fixed, so bytes never depend on insertion order.
            if (e.Name is not null) line.Key("name").Str(e.Name);
            if (e.Signature is not null) line.Key("signature").Str(e.Signature);
            if (e.DeclaredType is not null) line.Key("declaredType").Int(Ref(e.DeclaredType, $"{key}.declaredType"));
            if (e.IsStub is not null) line.Key("isStub").Bool(e.IsStub.Value);
            if (e.Parent is not null) line.Key("parent").Int(Ref(e.Parent, $"{key}.parent"));
            if (e.AttachedTo is not null) line.Key("attachedTo").Int(Ref(e.AttachedTo, $"{key}.attachedTo"));
            if (e.Parameters is not null) line.Key("parameters").Ints(e.Parameters.Select(p => Ref(p, $"{key}.parameters")));
            if (e.LocalVariables is not null) line.Key("localVariables").Ints(e.LocalVariables.Select(l => Ref(l, $"{key}.localVariables")));
            if (e.DefinedIn is not null) line.Key("definedIn").Ints(e.DefinedIn.Select(File));
            if (e.Comments is not null) line.Key("comments").Strs(e.Comments);
            if (e.Metrics is not null)
            {
                line.Key("metrics").BeginObject();
                foreach (var (name, value) in e.Metrics.OrderBy(p => p.Key, StringComparer.Ordinal)) line.Key(name).Number(value);
                line.EndObject();
            }
            if (e.Value is not null) { line.Key("value"); WriteLiteral(line, e.Value, k => Ref(k, $"{key}.value")); }
            if (e.Anchor is not null) WriteAnchor(line.Key("anchor"), e.Anchor, File);
            yield return line.EndObject().ToString();
        }

        var edgeKindIndex = Index(edgeKinds);
        var provenanceIndex = Index(provenance);
        var edges = model.Edges
            .Select(edge => (edge, f: Ref(edge.From, $"edge {edge.Kind}"), o: Ref(edge.To, $"edge {edge.Kind}")))
            .OrderBy(x => x.f).ThenBy(x => x.o)
            .ThenBy(x => x.edge.Kind, StringComparer.Ordinal)
            .ThenBy(x => File(x.edge.Anchor.File)).ThenBy(x => x.edge.Anchor.StartLine).ThenBy(x => x.edge.Anchor.EndLine)
            .ThenBy(x => x.edge.Provenance, StringComparer.Ordinal)
            .ToList();
        foreach (var (edge, f, o) in edges)
        {
            if (f == o) throw new InvalidOperationException($"self-referencing edge is not representable: {edge.Kind} on {edge.From}");
            var line = new JsonLine().BeginObject()
                .Key("t").Str("x")
                .Key("k").Int(edgeKindIndex[edge.Kind])
                .Key("f").Int(f)
                .Key("o").Int(o)
                .Key("p").Int(provenanceIndex[edge.Provenance]);
            // EDGE_KEY_ORDER: candidates, arguments, isRead, isWrite, sourceFile, anchor.
            if (edge.Arguments is { Count: > 0 })
            {
                line.Key("arguments").BeginArray();
                foreach (var argument in edge.Arguments)
                {
                    line.BeginObject().Key("name").Str(argument.Name).Key("value");
                    WriteLiteral(line, argument.Value, k => Ref(k, $"edge {edge.Kind} arguments"));
                    line.EndObject();
                }
                line.EndArray();
            }
            if (edge.IsRead is not null) line.Key("isRead").Bool(edge.IsRead.Value);
            if (edge.IsWrite is not null) line.Key("isWrite").Bool(edge.IsWrite.Value);
            if (edge.SourceFile is not null) line.Key("sourceFile").Int(File(edge.SourceFile));
            WriteAnchor(line.Key("anchor"), edge.Anchor, File);
            yield return line.EndObject().ToString();
        }

        yield return new JsonLine().BeginObject().Key("t").Str("eof").Key("counts").BeginObject()
            .Key("files").Int(files.Count).Key("entities").Int(entities.Count).Key("edges").Int(edges.Count)
            .EndObject().EndObject().ToString();
    }

    private static void WriteAnchor(JsonLine line, SourceAnchor anchor, Func<string, int> file) =>
        line.BeginArray().Int(file(anchor.File)).Int(anchor.StartLine).Int(anchor.EndLine).EndArray();

    private static void WriteLiteral(JsonLine line, Literal literal, Func<NaturalKey, int> reference)
    {
        line.BeginObject();
        switch (literal)
        {
            case Literal.String s: line.Key("k").Str("string").Key("v").Str(s.V); break;
            case Literal.Number n: line.Key("k").Str("number").Key("v").Str(n.V); break;
            case Literal.Boolean b: line.Key("k").Str("boolean").Key("v").Bool(b.V); break;
            case Literal.Null: line.Key("k").Str("null"); break;
            case Literal.Enum e: line.Key("k").Str("enum").Key("type").Int(reference(e.Type)).Key("name").Str(e.Name); break;
            case Literal.TypeValue t: line.Key("k").Str("type").Key("type").Int(reference(t.Target)); break;
            case Literal.Array a:
                line.Key("k").Str("array").Key("items").BeginArray();
                foreach (var item in a.Items) WriteLiteral(line, item, reference);
                line.EndArray();
                break;
            case Literal.Annotation an:
                line.Key("k").Str("annotation").Key("type").Int(reference(an.Type)).Key("arguments").BeginArray();
                foreach (var argument in an.Arguments)
                {
                    line.BeginObject().Key("name").Str(argument.Name).Key("value");
                    WriteLiteral(line, argument.Value, reference);
                    line.EndObject();
                }
                line.EndArray();
                break;
            case Literal.Unevaluated u: line.Key("k").Str("unevaluated").Key("source").Str(u.Source); break;
            default: throw new InvalidOperationException($"unknown literal: {literal}");
        }
        line.EndObject();
    }

    private static List<string> Paths(ExtractedModel model)
    {
        var paths = new HashSet<string>(StringComparer.Ordinal);
        foreach (var e in model.Entities)
        {
            if (e.Anchor is not null) paths.Add(e.Anchor.File);
            if (e.DefinedIn is not null) foreach (var p in e.DefinedIn) paths.Add(p);
        }
        foreach (var edge in model.Edges)
        {
            paths.Add(edge.Anchor.File);
            if (edge.SourceFile is not null) paths.Add(edge.SourceFile);
        }
        return paths.OrderBy(p => p, StringComparer.Ordinal).ToList();
    }

    private static List<string> Dict(IEnumerable<string> values) =>
        values.Distinct(StringComparer.Ordinal).OrderBy(v => v, StringComparer.Ordinal).ToList();

    private static Dictionary<string, int> Index(List<string> values)
    {
        var index = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < values.Count; i++) index[values[i]] = i;
        return index;
    }
}
