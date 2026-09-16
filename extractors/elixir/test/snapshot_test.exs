defmodule CodegraphElixir.SnapshotTest do
  use ExUnit.Case, async: true

  import CodegraphElixir.Test.Harness
  alias CodegraphElixir.Model.Writer

  @moduledoc """
  The fixture corpus → the committed snapshot, byte for byte. Core's reference
  reader re-validates the same bytes on the TypeScript side
  (`packages/core/test/fixtures-elixir.test.ts`); what this side pins is the
  walking skeleton's evidence by id (PLAN.md §16.6).
  """

  setup_all do
    result = extract_fixture()
    %{output: Writer.encode_to_string(result.model), model: result.model, stats: result.stats}
  end

  test "reproduces the committed snapshot exactly", %{output: output} do
    assert output == File.read!(snapshot())
  end

  test "names the extractor and the toolchain that produced it", %{output: output} do
    header = output |> String.split("\n") |> hd() |> JSON.decode!()
    assert header["lang"] == "ex"
    assert header["root"] == fixture_src()
    assert header["extractor"]["name"] == "codegraph-elixir"
    assert header["extractor"]["elixir"] =~ ~r/^\d+\.\d+\.\d+/
    assert header["extractor"]["otp"] =~ ~r/^\d+$/
  end

  test "keys every entity by its FILE, with dots and reserved characters escaped (PLAN §16.3)", %{
    model: model
  } do
    ids = ids(model)
    assert "ex:lib%2Facme_order%2Forder.ex" in ids
    assert "ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder" in ids
    assert "ex:lib%2Facme_order%2Fpromo%232024.ex/AcmeOrder%2EPromo2024.apply#1" in ids
    assert find(model, "ex:lib%2Facme_order%2Fpromo%232024.ex").name == "lib/acme_order/promo#2024.ex"
    # An atom-named module keeps its dots in the name and escapes them in the key.
    assert find(model, "ex:lib%2Facme_order%2Flegacy%2Fatom_module.ex/legacy%2Emod").name == "legacy.mod"
    # Nesting defines the full name as a second child of the FILE.
    gateway = find(model, "ex:lib%2Facme_order%2Fnotifier.ex/AcmeOrder%2ENotifier%2ESms%2EGateway")
    assert gateway.parent == find(model, "ex:lib%2Facme_order%2Fnotifier.ex").key
  end

  test "arity is identity: clauses and defaults fold into one entity", %{model: model} do
    create = find(model, "ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder.create#2")
    assert create.signature == "create/2"
    assert create.extra == [{"defaults", 1}]
    refute "ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder.create#1" in ids(model)

    total = find(model, "ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder.total#1")
    assert total.anchor == {"lib/acme_order/order.ex", 19, 25}
    add_line = find(model, "ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder.add_line#2")
    assert add_line.anchor == {"lib/acme_order/order.ex", 27, 31}
    assert find(model, "ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder.describe#1").kind == "function"

    for entity <- model.entities, entity.kind in ["function", "macro", "callback"] do
      assert entity.key.d != nil, CodegraphElixir.Model.Key.render(entity.key)
    end
  end

  test "defp is the same kind with a pass-through key; macros, guards and protocol defs are their kinds", %{
    model: model
  } do
    assert find(model, "ex:mix.exs/AcmeOrder%2EMixProject.deps#0").extra == [{"private", true}]
    assert find(model, "ex:lib%2Facme_order%2Fmacros.ex/AcmeOrder%2EMacros.__using__#1").kind == "macro"
    assert find(model, "ex:lib%2Facme_order%2Fmacros.ex/AcmeOrder%2EMacros.is_channel#1").kind == "macro"
    assert find(model, "ex:lib%2Facme_order%2Fpriceable.ex/AcmeOrder%2EPriceable").kind == "protocol"
    assert find(model, "ex:lib%2Facme_order%2Fpriceable.ex/AcmeOrder%2EPriceable.price#1").kind == "callback"
  end

  test "defimpl is a named module attached to its type, with the edge at the block (PLAN §16.2)", %{
    model: model
  } do
    impl = find(model, "ex:lib%2Facme_order%2Fmoney.ex/String%2EChars%2EAcmeOrder%2EMoney")
    money = find(model, "ex:lib%2Facme_order%2Fmoney.ex/AcmeOrder%2EMoney")
    assert impl.attached_to == money.key
    assert "TAttachedTo" in impl.traits and "TWithImplements" in impl.traits

    edge = Enum.find(model.edges, &(&1.from == money.key and &1.kind == "interfaceImplementation"))
    assert CodegraphElixir.Model.Key.render(edge.to) == "ex:<otp>/String%2EChars"
    assert edge.anchor == {"lib/acme_order/money.ex", 16, 18}

    # A protocol's impl for a corpus type, written in the protocol's file.
    assert edge?(
             model,
             "interfaceImplementation",
             "ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder",
             "ex:lib%2Facme_order%2Fpriceable.ex/AcmeOrder%2EPriceable"
           )

    assert edge?(
             model,
             "interfaceImplementation",
             "ex:<otp>/Any",
             "ex:lib%2Facme_order%2Fpriceable.ex/AcmeOrder%2EPriceable"
           )
  end

  test "carries the evidence the stub discipline exists to prove (PLAN §16.4)", %{model: model} do
    otp = find(model, "ex:<otp>")
    assert otp.kind == "file" and otp.is_stub == true and otp.defined_in == []
    gen_server = find(model, "ex:<otp>/GenServer")
    assert gen_server.kind == "module" and gen_server.is_stub == true and gen_server.parent == otp.key
    assert find(model, "ex:<deps>/Ecto%2ESchema").is_stub == true
    assert edge?(model, "import", "ex:lib%2Facme_order%2Fstock.ex", "ex:<otp>/GenServer")
    assert edge?(model, "import", "ex:lib%2Facme_order%2Fschema%2Fline.ex", "ex:<deps>/Ecto%2ESchema")
    # A corpus target: file -> file, and the implementation edge lands on the declared module.
    assert edge?(
             model,
             "import",
             "ex:lib%2Facme_order%2Fpricing%2Fpremium.ex",
             "ex:lib%2Facme_order%2Fpricing%2Fstandard.ex"
           )

    assert edge?(
             model,
             "interfaceImplementation",
             "ex:lib%2Facme_order%2Fpricing%2Fstandard.ex/AcmeOrder%2EPricing%2EStandard",
             "ex:lib%2Facme_order%2Fpricing.ex/AcmeOrder%2EPricing"
           )

    refute "ex:<deps>/AcmeOrder%2EPricing" in ids(model)
  end

  test "a file the parser rejects is a file record with no entities, counted", %{model: model, stats: stats} do
    broken = find(model, "ex:lib%2Facme_order%2Flegacy%2Fbroken.ex")
    assert broken != nil
    refute Enum.any?(model.entities, &(&1.parent == broken.key))
    assert [unparsed] = stats.unparsed
    assert unparsed =~ ~r{^lib/acme_order/legacy/broken.ex: line 4}
    # Two aliases naming a module of their own file are self-edges, dropped.
    assert stats.self_edges_dropped == 2
    assert stats.unclosable == []
    assert stats.duplicate_keys == []
  end
end
