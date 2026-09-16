defmodule CodegraphElixir.WalkerTest do
  use ExUnit.Case, async: true

  alias CodegraphElixir.{Corpus, Walker}
  alias CodegraphElixir.Model.Key

  @moduledoc "One file's AST → entities and raw edges: the folds, the kinds, the scopes."

  defp walk(source, rel \\ "lib/x.ex"), do: Walker.walk(Corpus.from_source(rel, source))
  defp by_id(acc), do: Map.new(acc.entities, &{Key.render(&1.key), &1})

  test "folds clauses and defaults, keeps privacy as a pass-through key, kinds macros and guards" do
    acc =
      walk("""
      defmodule Acme.Fold do
        def f(a, b \\\\ 1), do: a + b
        def f(a, b) when is_list(a), do: b
        defp g(x), do: x
        defmacro m(x), do: x
        defguard is_pos(n) when n > 0
        defdelegate h(a), to: Other
        def none, do: :ok
      end
      """)

    ids = by_id(acc)
    f = ids["ex:lib%2Fx.ex/Acme%2EFold.f#2"]
    assert f.kind == "function" and f.signature == "f/2" and f.extra == [{"defaults", 1}]
    assert f.anchor == {"lib/x.ex", 2, 3}
    refute Map.has_key?(ids, "ex:lib%2Fx.ex/Acme%2EFold.f#1")
    assert ids["ex:lib%2Fx.ex/Acme%2EFold.g#1"].extra == [{"private", true}]
    assert ids["ex:lib%2Fx.ex/Acme%2EFold.m#1"].kind == "macro"
    assert ids["ex:lib%2Fx.ex/Acme%2EFold.is_pos#1"].kind == "macro"
    assert ids["ex:lib%2Fx.ex/Acme%2EFold.h#1"].kind == "function"
    assert ids["ex:lib%2Fx.ex/Acme%2EFold.none#0"].anchor == {"lib/x.ex", 8, 8}
    assert ids["ex:lib%2Fx.ex/Acme%2EFold"].anchor == {"lib/x.ex", 1, 9}
    assert acc.declared == [{Acme.Fold, ids["ex:lib%2Fx.ex/Acme%2EFold"].key, ids["ex:lib%2Fx.ex"].key}]
  end

  test "nested modules are children of the file and alias their first segment; defimpl is attached" do
    acc =
      walk("""
      defmodule Acme.Outer do
        defmodule Inner do
          def i, do: :ok
        end

        defmodule Deep.Down do
          def d, do: :ok
        end

        @behaviour Inner
        @behaviour Deep.Down

        defimpl String.Chars do
          def to_string(_), do: ""
        end
      end
      """)

    ids = by_id(acc)
    file = ids["ex:lib%2Fx.ex"].key
    assert ids["ex:lib%2Fx.ex/Acme%2EOuter%2EInner"].parent == file
    assert ids["ex:lib%2Fx.ex/Acme%2EOuter%2EDeep%2EDown.d#0"].kind == "function"
    impl = ids["ex:lib%2Fx.ex/String%2EChars%2EAcme%2EOuter"]
    assert impl.attached_to == {:module, Acme.Outer}
    assert "TAttachedTo" in impl.traits
    assert "TWithImplements" in ids["ex:lib%2Fx.ex/Acme%2EOuter"].traits

    targets = for e <- acc.edges, e.kind == "interfaceImplementation", do: {e.from, e.to}
    outer = ids["ex:lib%2Fx.ex/Acme%2EOuter"].key
    assert {outer, {:module, Acme.Outer.Inner}} in targets
    assert {outer, {:module, Acme.Outer.Deep.Down}} in targets
    assert {{:module, Acme.Outer}, {:module, String.Chars}} in targets
  end

  test "a protocol's defs are callbacks; defimpl with for: names the compiler's module" do
    acc =
      walk("""
      defprotocol Acme.P do
        def size(t)
      end

      defimpl Acme.P, for: [Map, Acme.Thing] do
        def size(_), do: 0
      end
      """)

    ids = by_id(acc)
    assert ids["ex:lib%2Fx.ex/Acme%2EP"].kind == "protocol"
    assert ids["ex:lib%2Fx.ex/Acme%2EP.size#1"].kind == "callback"
    assert ids["ex:lib%2Fx.ex/Acme%2EP%2EMap.size#1"].kind == "function"
    assert ids["ex:lib%2Fx.ex/Acme%2EP%2EAcme%2EThing"].attached_to == {:module, Acme.Thing}
  end

  test "import forms are edges from the file, scoped, counted by form, and quote blocks are skipped" do
    acc =
      walk("""
      defmodule Acme.Imports do
        alias Acme.{A, B}
        alias Acme.Long.Name, as: Short
        import Enum, only: [map: 2]
        require Logger
        use GenServer

        def f do
          alias Acme.Inner
          Inner.g()
        end

        defmacro m do
          quote do
            alias Should.Not.Count
          end
        end

        if Mix.env() == :test do
          def only_in_test, do: :ok
          alias Acme.Conditional
        end
      end
      """)

    targets = for e <- acc.edges, e.kind == "import", do: e.to
    assert {:file_of, Acme.A} in targets
    assert {:file_of, Acme.B} in targets
    assert {:file_of, Acme.Long.Name} in targets
    assert {:file_of, Enum} in targets
    assert {:file_of, Logger} in targets
    assert {:file_of, GenServer} in targets
    assert {:file_of, Acme.Inner} in targets
    assert {:file_of, Acme.Conditional} in targets
    refute {:file_of, Should.Not.Count} in targets
    assert acc.imports == %{alias: 5, import: 1, require: 1, use: 1}
    assert Enum.all?(acc.edges, &(&1.from == Key.module("lib%2Fx.ex")))
    assert Map.has_key?(by_id(acc), "ex:lib%2Fx.ex/Acme%2EImports.only_in_test#0")
  end

  test "two declarations of one key in one file: the later is re-keyed by position and named" do
    acc =
      walk("""
      defmodule Dup do
        def a, do: 1
      end

      defmodule Dup do
        def a, do: 2
      end
      """)

    ids = by_id(acc)
    assert Map.has_key?(ids, "ex:lib%2Fx.ex/Dup")
    assert Map.has_key?(ids, "ex:lib%2Fx.ex/Dup#5:1")
    assert Map.has_key?(ids, "ex:lib%2Fx.ex/Dup#5:1#a#0")
    assert acc.duplicate_keys == ["ex:lib%2Fx.ex/Dup -> ex:lib%2Fx.ex/Dup#5:1"]
  end

  test "a dynamic module name is dropped and counted; a script file yields its file alone" do
    acc =
      walk("""
      for name <- [:a, :b] do
        defmodule Module.concat(Gen, name) do
        end
      end
      """)

    assert acc.dynamic_modules == 1
    assert length(acc.entities) == 1
    assert walk("import Config\nconfig :app, key: 1\n", "config/config.exs").imports.import == 1
  end
end
