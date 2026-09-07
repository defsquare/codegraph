using Codegraph.CSharp.Model;

namespace Codegraph.CSharp.Tests;

/// <summary>The line builder reproduces `JSON.stringify`: what it escapes, and what it must NOT.</summary>
public class JsonTest
{
    [Theory]
    [InlineData("plain", "\"plain\"")]
    [InlineData("quote\"back\\slash", "\"quote\\\"back\\\\slash\"")]
    [InlineData("tab\tnl\ncr\rbs\bff\f", "\"tab\\tnl\\ncr\\rbs\\bff\\f\"")]
    [InlineData("nul\u0000esc\u001b", "\"nul\\u0000esc\\u001b\"")]
    [InlineData("<global> & </summary> / 'q' +", "\"<global> & </summary> / 'q' +\"")]
    [InlineData("naïve «Résumé» 𠀀 Ａ", "\"naïve «Résumé» 𠀀 Ａ\"")]
    [InlineData("\u2028\u2029", "\"\u2028\u2029\"")]
    public void QuotesLikeJsonStringify(string input, string expected)
    {
        Assert.Equal(expected, JsonLine.Quote(input));
    }

    [Fact]
    public void ALoneSurrogateIsEscapedLowercase()
    {
        Assert.Equal("\"\\ud800x\"", JsonLine.Quote("\ud800x"));
        Assert.Equal("\"\\udc00\"", JsonLine.Quote("\udc00"));
    }

    [Fact]
    public void ObjectsAndArraysCarryNoWhitespaceAndCommasOnlyBetweenMembers()
    {
        var line = new JsonLine().BeginObject()
            .Key("t").Str("e").Key("i").Int(0).Key("tr").Ints([1, 2]).Key("empty").BeginArray().EndArray()
            .Key("o").BeginObject().Key("a").Bool(true).Key("b").Null().EndObject()
            .Key("n").Number(3).Key("h").Number(0.5)
            .EndObject().ToString();
        Assert.Equal("{\"t\":\"e\",\"i\":0,\"tr\":[1,2],\"empty\":[],\"o\":{\"a\":true,\"b\":null},\"n\":3,\"h\":0.5}", line);
    }

    [Fact]
    public void ANonFiniteMeasureIsRefused()
    {
        Assert.Throws<ArgumentException>(() => new JsonLine().Number(double.NaN));
    }
}
