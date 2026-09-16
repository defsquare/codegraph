defmodule CodegraphElixir.Model.Key do
  @moduledoc """
  A natural key `(module, symbol, disambiguator?)` — `lang` is `ex` for every
  key this extractor writes, so it is not carried. A module names itself:
  empty symbol, no disambiguator (schemas/README.md §2).

  Canonical order compares by UTF-16 code unit, component by component, a
  missing disambiguator before any present one — that order IS the surrogate
  assignment (§6). Elixir strings are UTF-8, so the comparison key is the
  UTF-16BE encoding, whose byte order is code-unit order.
  """

  @enforce_keys [:module, :symbol]
  defstruct [:module, :symbol, d: nil]

  @type t :: %__MODULE__{module: String.t(), symbol: String.t(), d: String.t() | nil}

  @lang "ex"

  def lang, do: @lang

  def module(module), do: %__MODULE__{module: module, symbol: ""}

  def module?(%__MODULE__{symbol: "", d: nil}), do: true
  def module?(%__MODULE__{}), do: false

  @doc "Injective grouping projection for maps — component-wise equality made hashable."
  def index(%__MODULE__{module: m, symbol: s, d: d}), do: {m, s, d}

  @doc "UTF-16 code-unit order as a byte-comparable binary."
  def utf16(text), do: :unicode.characters_to_binary(text, :utf8, {:utf16, :big})

  @doc "The sort key realising canonical order (§6)."
  def sort_key(%__MODULE__{module: m, symbol: s, d: nil}), do: {utf16(m), utf16(s), 0, <<>>}
  def sort_key(%__MODULE__{module: m, symbol: s, d: d}), do: {utf16(m), utf16(s), 1, utf16(d)}

  @doc "Total order on text by UTF-16 code unit — locale-independent, like every sort here."
  def compare_text(a, b) do
    ua = utf16(a)
    ub = utf16(b)

    cond do
      ua < ub -> :lt
      ua > ub -> :gt
      true -> :eq
    end
  end

  @doc "`Owner.member` below an owner that has no disambiguator; below the owner's own disambiguator otherwise."
  def member(%__MODULE__{d: nil} = owner, name) do
    symbol = if owner.symbol == "", do: name, else: owner.symbol <> "." <> name
    %__MODULE__{module: owner.module, symbol: symbol}
  end

  def member(%__MODULE__{} = owner, name), do: disambiguated(owner, name)

  def disambiguated(%__MODULE__{d: nil} = owner, tag), do: %__MODULE__{owner | d: tag}
  def disambiguated(%__MODULE__{d: d} = owner, tag), do: %__MODULE__{owner | d: d <> "#" <> tag}

  @doc "The display projection `ex:<module>[/<symbol>][#<d>]` — for humans, messages and tests only."
  def render(%__MODULE__{module: m, symbol: s, d: d}) do
    symbol = if s == "", do: "", else: "/" <> s
    disambiguator = if d == nil, do: "", else: "#" <> d
    @lang <> ":" <> m <> symbol <> disambiguator
  end
end
