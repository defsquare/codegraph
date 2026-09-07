using System.Globalization;
using System.Text;

namespace Codegraph.CSharp.Model;

/// <summary>
/// A JSON line builder that reproduces `JSON.stringify` byte for byte: no
/// whitespace, `"` and `\` escaped, control characters as the short escapes or
/// `\u00xx`, lone surrogates as `\udxxx`, and NOTHING else escaped — `<`, `>`,
/// `&`, `/` and every non-ASCII character are written as they are. Core's
/// encoder is the reference; the fixture gate compares the two outputs.
/// </summary>
public sealed class JsonLine
{
    private readonly StringBuilder sb = new();
    // One flag per open container: does the next member need a comma first?
    private readonly Stack<bool> needsComma = new();
    private bool afterKey;

    private void BeforeValue()
    {
        if (afterKey) { afterKey = false; return; }
        if (needsComma.Count == 0) return;
        if (needsComma.Pop()) sb.Append(',');
        needsComma.Push(true);
    }

    public JsonLine BeginObject() { BeforeValue(); sb.Append('{'); needsComma.Push(false); return this; }
    public JsonLine EndObject() { needsComma.Pop(); sb.Append('}'); return this; }
    public JsonLine BeginArray() { BeforeValue(); sb.Append('['); needsComma.Push(false); return this; }
    public JsonLine EndArray() { needsComma.Pop(); sb.Append(']'); return this; }

    public JsonLine Key(string name)
    {
        BeforeValue();
        AppendString(sb, name);
        sb.Append(':');
        afterKey = true;
        return this;
    }

    public JsonLine Str(string value) { BeforeValue(); AppendString(sb, value); return this; }
    public JsonLine Int(long value) { BeforeValue(); sb.Append(value.ToString(CultureInfo.InvariantCulture)); return this; }
    public JsonLine Bool(bool value) { BeforeValue(); sb.Append(value ? "true" : "false"); return this; }
    public JsonLine Null() { BeforeValue(); sb.Append("null"); return this; }

    /// <summary>A finite number as JavaScript prints it: integral values without a fraction.</summary>
    public JsonLine Number(double value)
    {
        if (!double.IsFinite(value)) throw new ArgumentException("a measure must be finite", nameof(value));
        BeforeValue();
        if (Math.Floor(value) == value && Math.Abs(value) < 1e21)
            sb.Append(((long)value).ToString(CultureInfo.InvariantCulture));
        else
            sb.Append(value.ToString("R", CultureInfo.InvariantCulture));
        return this;
    }

    public JsonLine Ints(IEnumerable<int> values)
    {
        BeginArray();
        foreach (var v in values) Int(v);
        return EndArray();
    }

    public JsonLine Strs(IEnumerable<string> values)
    {
        BeginArray();
        foreach (var v in values) Str(v);
        return EndArray();
    }

    public override string ToString() => sb.ToString();

    public static string Quote(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        AppendString(sb, s);
        return sb.ToString();
    }

    public static void AppendString(StringBuilder sb, string s)
    {
        sb.Append('"');
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                    {
                        sb.Append(c).Append(s[i + 1]);
                        i++;
                    }
                    else if (char.IsSurrogate(c))
                    {
                        // Well-formed JSON.stringify (ES2019): a lone surrogate is escaped.
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    break;
            }
        }
        sb.Append('"');
    }
}
