defmodule CodegraphElixir.ScopeTest do
  use ExUnit.Case, async: true

  alias CodegraphElixir.Scope

  @moduledoc "The lexical resolver follows the compiler's alias rules and refuses anything dynamic."

  defp aliases(parts), do: {:__aliases__, [], parts}

  test "an unaliased name is absolute" do
    assert Scope.resolve(Scope.new(), aliases([:Foo, :Bar])) == Foo.Bar
  end

  test "the first segment is looked up in the alias table, the rest concatenated" do
    scope = Scope.add_alias(Scope.new(), X.Bar, :Bar)
    assert Scope.resolve(scope, aliases([:Bar])) == X.Bar
    assert Scope.resolve(scope, aliases([:Bar, :Baz])) == X.Bar.Baz
    assert Scope.resolve(scope, aliases([:"Elixir", :Bar])) == Bar
  end

  test "__MODULE__ is the enclosing module, alone or as a prefix" do
    scope = Scope.enter_module(Scope.new(), Acme.Order)
    assert Scope.resolve(scope, {:__MODULE__, [], nil}) == Acme.Order
    assert Scope.resolve(scope, aliases([{:__MODULE__, [], nil}, :Sub])) == Acme.Order.Sub
    assert Scope.resolve(Scope.new(), {:__MODULE__, [], nil}) == nil
  end

  test "an atom names a module directly; anything dynamic is nil" do
    assert Scope.resolve(Scope.new(), :ets) == :ets
    assert Scope.resolve(Scope.new(), :"legacy.mod") == :"legacy.mod"
    assert Scope.resolve(Scope.new(), aliases([{:unquote, [], [{:x, [], nil}]}])) == nil
    assert Scope.resolve(Scope.new(), {:mod, [], nil}) == nil
    assert Scope.resolve(Scope.new(), nil) == nil
    assert Scope.resolve(Scope.new(), true) == nil
  end

  test "module names drop the Elixir prefix and keep Erlang atoms bare" do
    assert Scope.module_name(Acme.Order) == "Acme.Order"
    assert Scope.module_name(:ets) == "ets"
    assert Scope.last_segment(Acme.Order.Line) == :Line
  end
end
