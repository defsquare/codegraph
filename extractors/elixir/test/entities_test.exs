defmodule CodegraphElixir.EntitiesTest do
  use ExUnit.Case, async: true

  alias CodegraphElixir.{Corpus, Literals, Measures, Scope, Walker}
  alias CodegraphElixir.Model.Key

  @moduledoc "Parameters, fields, attributes, callbacks, comments, values and measures — one file's entities."

  defp walk(source, rel \\ "lib/x.ex"), do: Walker.walk(Corpus.from_source(rel, source))
  defp by_id(acc), do: Map.new(acc.entities, &{Key.render(&1.key), &1})

  test "parameters are named by the first clause naming the position; a default is a value" do
    acc =
      walk("""
      defmodule A do
        def f(%{a: _} = order, _opts \\\\ [], count \\\\ 3), do: {order, count}
        def f(nil, opts, _), do: opts
      end
      """)

    ids = by_id(acc)
    f = ids["ex:lib%2Fx.ex/A.f#3"]

    assert f.parameters == [
             %Key{module: "lib%2Fx.ex", symbol: "A.f", d: "3#param:order"},
             %Key{module: "lib%2Fx.ex", symbol: "A.f", d: "3#param:opts"},
             %Key{module: "lib%2Fx.ex", symbol: "A.f", d: "3#param:count"}
           ]

    assert ids["ex:lib%2Fx.ex/A.f#3#param:count"].value == %{k: "number", v: "3"}
    assert ids["ex:lib%2Fx.ex/A.f#3#param:opts"].value == %{k: "array", items: []}
    assert "TWithValue" in ids["ex:lib%2Fx.ex/A.f#3#param:count"].traits
    assert ids["ex:lib%2Fx.ex/A.f#3#param:order"].name == "order"
    assert f.extra == [{"defaults", 2}]
  end

  test "an unnamed position is keyed by its ordinal and carries no name" do
    ids = walk("defmodule A do\n  def f(_, {a, _b}), do: a\nend\n") |> by_id()
    assert ids["ex:lib%2Fx.ex/A.f#2#param:1"].name == nil
    refute "TNamed" in ids["ex:lib%2Fx.ex/A.f#2#param:1"].traits
    assert Map.has_key?(ids, "ex:lib%2Fx.ex/A.f#2#param:2")
  end

  test "defstruct and defexception keys are fields with their defaults; a module used as a default is a type literal" do
    acc =
      walk("""
      defmodule A do
        defstruct [:ref, lines: [], pricing: Acme.Pricing, channel: :web]
      end

      defmodule E do
        defexception [:max, message: "too many"]
      end
      """)

    ids = by_id(acc)
    assert ids["ex:lib%2Fx.ex/A.ref"].kind == "field" and ids["ex:lib%2Fx.ex/A.ref"].value == nil
    assert ids["ex:lib%2Fx.ex/A.lines"].value == %{k: "array", items: []}
    assert ids["ex:lib%2Fx.ex/A.pricing"].value == %{k: "type", type: {:module, Acme.Pricing}}
    assert ids["ex:lib%2Fx.ex/A.channel"].value == %{k: "unevaluated", source: ":web"}
    assert ids["ex:lib%2Fx.ex/E.message"].value == %{k: "string", v: "too many"}

    assert Enum.find(acc.declared, &(&1.atom == A)).fields == %{
             ref: ids["ex:lib%2Fx.ex/A.ref"].key,
             lines: ids["ex:lib%2Fx.ex/A.lines"].key,
             pricing: ids["ex:lib%2Fx.ex/A.pricing"].key,
             channel: ids["ex:lib%2Fx.ex/A.channel"].key
           }
  end

  test "a non-reserved attribute is a constant; reserved ones are metadata; a redefinition keeps the first" do
    acc =
      walk("""
      defmodule A do
        @moduledoc "About A."
        @max 10
        @max 20
        @impl true
        @behaviour GenServer
        @names ["a", "b"]
        @doc "Adds."
        def f, do: @max
      end
      """)

    ids = by_id(acc)
    assert ids["ex:lib%2Fx.ex/A.@max"].value == %{k: "number", v: "10"}

    assert ids["ex:lib%2Fx.ex/A.@names"].value == %{
             k: "array",
             items: [%{k: "string", v: "a"}, %{k: "string", v: "b"}]
           }

    refute Map.has_key?(ids, "ex:lib%2Fx.ex/A.@impl")
    refute Map.has_key?(ids, "ex:lib%2Fx.ex/A.@behaviour")
    assert acc.counts[:attribute_redefined] == 1
    assert ids["ex:lib%2Fx.ex/A"].comments == ["About A."]
    assert ids["ex:lib%2Fx.ex/A.f#0"].comments == ["Adds."]
    assert "TComment" in ids["ex:lib%2Fx.ex/A.f#0"].traits
  end

  test "a # comment block directly above a definition is its comment; a blank line breaks it" do
    acc =
      walk("""
      # The module.
      defmodule A do
        # first
        # second
        def f, do: 1

        # far away

        def g, do: 2
      end
      """)

    ids = by_id(acc)
    assert ids["ex:lib%2Fx.ex/A"].comments == ["# The module."]
    assert ids["ex:lib%2Fx.ex/A.f#0"].comments == ["# first\n# second"]
    assert ids["ex:lib%2Fx.ex/A.g#0"].comments == nil
  end

  test "@callback and @spec name arities; their remote types are references from the callback or the function" do
    acc =
      walk("""
      defmodule B do
        @callback price(Acme.Line.t(), atom()) :: Acme.Money.t()
        @spec run(Acme.Order.t()) :: :ok
        def run(order), do: order
        @spec lost(term()) :: Acme.Lost.t()
      end
      """)

    ids = by_id(acc)
    price = ids["ex:lib%2Fx.ex/B.price#2"]
    assert price.kind == "callback"
    refs = for e <- acc.edges, e.kind == "reference", do: {Key.render(e.from), e.to}
    assert {"ex:lib%2Fx.ex/B.price#2", {:module, Acme.Line}} in refs
    assert {"ex:lib%2Fx.ex/B.price#2", {:module, Acme.Money}} in refs
    assert {"ex:lib%2Fx.ex/B.run#1", {:module, Acme.Order}} in refs
    # A spec naming no function of the module references from the module.
    assert {"ex:lib%2Fx.ex/B", {:module, Acme.Lost}} in refs
  end

  test "sloc counts token-bearing lines and cyclomatic counts the branches of every clause" do
    source = """
    defmodule A do
      # a comment line

      def f(x) do
        case x do
          1 -> :one
          2 -> :two
          _ -> if x > 2 and x < 10, do: :small, else: :big
        end
      end

      def f(nil), do: nil
    end
    """

    acc = walk(source)
    ids = by_id(acc)
    assert ids["ex:lib%2Fx.ex"].metrics == [{"sloc", 10}]
    assert ids["ex:lib%2Fx.ex/A.f#1"].metrics == [{"sloc", 8}, {"cyclomatic", 6}]
    assert Measures.cyclomatic(quote(do: (a && b) || c)) == 3
  end

  test "literals: constant-shaped values are kept, code carries none" do
    scope = Scope.new()
    assert Literals.value_of(quote(do: 1.5), scope) == %{k: "number", v: "1.5"}
    assert Literals.value_of(quote(do: -2), scope) == %{k: "number", v: "-2"}
    assert Literals.value_of(quote(do: true), scope) == %{k: "boolean", v: true}
    assert Literals.value_of(quote(do: nil), scope) == %{k: "null"}
    assert Literals.value_of(quote(do: {:a, 1}), scope) == %{k: "unevaluated", source: "{:a, 1}"}
    assert Literals.value_of(quote(do: %{a: 1}), scope) == %{k: "unevaluated", source: "%{a: 1}"}
    assert Literals.value_of(quote(do: Enum.map(x, y)), scope) == nil
    assert Literals.value_of(quote(do: fn -> 1 end), scope) == nil
  end
end
