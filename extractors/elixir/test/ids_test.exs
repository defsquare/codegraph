defmodule CodegraphElixir.IdsTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias CodegraphElixir.Ids
  alias CodegraphElixir.Model.Key

  @moduledoc "The id scheme (PLAN.md §16.3): escaping is injective and reversible; arity is identity."

  property "escaping a name round-trips and leaves no reserved character behind" do
    check all(text <- string(:printable)) do
      escaped = Ids.escape_name(text)
      assert Ids.unescape(escaped) == text
      refute String.contains?(escaped, ["/", "#", "."])
    end
  end

  property "escaping a path keeps its dots and round-trips" do
    check all(text <- string(:printable)) do
      escaped = Ids.escape_path(text)
      assert Ids.unescape(escaped) == text
      refute String.contains?(escaped, ["/", "#"])
    end
  end

  property "canonical order is by UTF-16 code unit, whatever the bytes say" do
    check all(a <- string(:printable), b <- string(:printable)) do
      expected =
        case {Key.utf16(a), Key.utf16(b)} do
          {x, y} when x < y -> :lt
          {x, y} when x > y -> :gt
          _ -> :eq
        end

      assert Key.compare_text(a, b) == expected
    end
  end

  test "a character above the BMP sorts BEFORE U+FFFF, as JavaScript sorts it" do
    # UTF-8 bytes say the opposite (F0… > EF…); the contract is code units.
    assert Key.compare_text("\u{10000}", "\u{FFFF}") == :lt
  end

  test "renders the shapes of §16.3" do
    assert Key.render(Ids.file_key("lib/acme_order/order.ex")) == "ex:lib%2Facme_order%2Forder.ex"
    assert Key.render(Ids.file_key("lib/promo#2024.ex")) == "ex:lib%2Fpromo%232024.ex"
    module = Ids.module_key("lib/a.ex", AcmeOrder.Order)
    assert Key.render(module) == "ex:lib%2Fa.ex/AcmeOrder%2EOrder"
    assert Key.render(Ids.function_key(module, :total, 1)) == "ex:lib%2Fa.ex/AcmeOrder%2EOrder.total#1"
    assert Key.render(Ids.function_key(module, :valid?, 2)) == "ex:lib%2Fa.ex/AcmeOrder%2EOrder.valid?#2"
    assert Key.render(Ids.module_key("lib/a.ex", :"legacy.mod")) == "ex:lib%2Fa.ex/legacy%2Emod"
    assert Key.render(Ids.stub_module_key(:otp, :ets)) == "ex:<otp>/ets"
    assert Key.render(Ids.stub_module_key(:deps, Ecto.Changeset)) == "ex:<deps>/Ecto%2EChangeset"
  end

  test "a module key names itself and sorts before everything below it" do
    file = Ids.file_key("lib/a.ex")
    assert Key.module?(file)
    module = Ids.module_key("lib/a.ex", A)
    refute Key.module?(module)
    assert Key.sort_key(file) < Key.sort_key(module)
    # An absent disambiguator sorts first.
    plain = %Key{module: "m", symbol: "s"}
    assert Key.sort_key(plain) < Key.sort_key(%Key{plain | d: "0"})
  end
end
