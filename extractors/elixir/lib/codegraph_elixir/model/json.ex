defmodule CodegraphElixir.Model.Json do
  @moduledoc """
  The bytes `JSON.stringify` writes, for the value shapes a record holds:
  objects in a CALLER-CHOSEN key order (maps are unordered, and the order is
  the contract), strings escaped exactly as V8 does (`"`, `\\`, control
  characters as `\\uXXXX` or the short escapes; `/` and everything non-ASCII
  raw), integers, shortest round-trip floats, booleans, null, arrays.
  """

  @doc "An object from `[{key, value}]` pairs, in that order."
  def object(pairs) when is_list(pairs) do
    body =
      pairs
      |> Enum.map(fn {key, value} -> [string(to_string(key)), ?:, value(value)] end)
      |> Enum.intersperse(?,)

    [?{, body, ?}]
  end

  def value({:object, pairs}), do: object(pairs)
  def value(nil), do: "null"
  def value(true), do: "true"
  def value(false), do: "false"
  def value(text) when is_binary(text), do: string(text)
  def value(int) when is_integer(int), do: Integer.to_string(int)

  # JSON.stringify(2.0) is "2": an integral float prints as an integer.
  def value(float) when is_float(float) do
    if float == Float.floor(float) and abs(float) < 1.0e21 do
      float |> trunc() |> Integer.to_string()
    else
      :erlang.float_to_binary(float, [:short])
    end
  end

  def value(list) when is_list(list), do: [?[, list |> Enum.map(&value/1) |> Enum.intersperse(?,), ?]]

  @doc "`:json.encode_binary/1` escapes the same set as V8 and leaves the rest raw."
  def string(text) when is_binary(text), do: :json.encode_binary(text)
end
