defmodule CodegraphElixir.JsonTest do
  use ExUnit.Case, async: true

  alias CodegraphElixir.Model.Json

  @moduledoc "The bytes JSON.stringify writes: the two-encoder gate rests on these."

  defp out(iodata), do: IO.iodata_to_binary(iodata)

  test "escapes exactly what V8 escapes and leaves the rest raw" do
    # `/` raw, non-ASCII raw (U+2028 included), a control character as ,
    # the short escapes for tab, quote and backslash, an astral character raw.
    line_separator = <<0xE2, 0x80, 0xA8>>
    input = "a/b é " <> line_separator <> " " <> <<1>> <> " \t \"q\" \\ 😀"
    expected = "\"a/b é " <> line_separator <> " \\u0001 \\t \\\"q\\\" \\\\ 😀\""
    assert out(Json.string(input)) == expected
  end

  test "writes integral floats as integers and the rest shortest round-trip" do
    assert out(Json.value(2.0)) == "2"
    assert out(Json.value(1.5)) == "1.5"
    assert out(Json.value(0.1)) == "0.1"
    assert out(Json.value(42)) == "42"
  end

  test "keeps the caller's key order, and nests" do
    assert out(Json.object([{"b", 1}, {"a", [true, nil, {:object, [{"z", "s"}]}]}])) ==
             "{\"b\":1,\"a\":[true,null,{\"z\":\"s\"}]}"
  end
end
