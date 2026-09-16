defmodule CodegraphElixir.BodyTest do
  use ExUnit.Case, async: true

  alias CodegraphElixir.{Corpus, Walker}
  alias CodegraphElixir.Model.Key

  @moduledoc """
  What one body writes, as RAW targets — names, not keys: the extraction
  closes them. Each test is one row of the §16.2 mapping table.
  """

  defp walk(source, rel \\ "lib/x.ex"), do: Walker.walk(Corpus.from_source(rel, source))

  defp edges(acc, from_suffix) do
    for e <- acc.edges, String.ends_with?(Key.render(e.from), from_suffix), do: {e.kind, e.to, e.provenance}
  end

  defp targets(acc, from_suffix, kind), do: for({k, to, _} <- edges(acc, from_suffix), k == kind, do: to)

  test "remote calls resolve the receiver through the scope; a pipe adds one to the arity" do
    acc =
      walk("""
      defmodule A do
        alias Acme.Money, as: M
        def f(x) do
          M.new(x)
          x |> Enum.map(&M.add/2) |> Acme.Order.total()
          :ets.lookup(:t, x)
        end
      end
      """)

    calls = targets(acc, "A.f#1", "invocation")
    assert {:function, Acme.Money, :new, 1} in calls
    assert {:function, Enum, :map, 2} in calls
    assert {:function, Acme.Order, :total, 1} in calls
    assert {:function, :ets, :lookup, 2} in calls
    # The capture is a reference, never an invocation.
    assert {:function, Acme.Money, :add, 2} in targets(acc, "A.f#1", "reference")
    refute {:function, Acme.Money, :add, 2} in calls
  end

  test "local calls carry the imports in force; captures of locals are references" do
    acc =
      walk("""
      defmodule A do
        import Acme.Helpers, only: [help: 1]
        def f(x), do: help(x) + g(&h/2)
        def g(fun), do: fun
        def h(a, b), do: {a, b}
      end
      """)

    [{:local, A, :help, 1, snapshot}] =
      for {:local, A, :help, 1, s} <- targets(acc, "A.f#1", "invocation"), do: {:local, A, :help, 1, s}

    assert snapshot.imports == [{Acme.Helpers, {:only, [help: 1]}}]
    assert Enum.any?(targets(acc, "A.f#1", "invocation"), &match?({:local, A, :g, 1, _}, &1))
    assert Enum.any?(targets(acc, "A.f#1", "reference"), &match?({:local, A, :h, 2, _}, &1))
  end

  test "a struct is a reference to its module and its keys are field accesses, read in a pattern, written otherwise" do
    acc =
      walk("""
      defmodule A do
        def f(%Acme.Order{lines: lines} = order) do
          %Acme.Order{order | lines: [1 | lines]}
          %Acme.Money{amount: 1}
        end
      end
      """)

    edges = edges(acc, "A.f#1")
    assert {"reference", {:module, Acme.Order}, "declared"} in edges
    reads = for e <- acc.edges, e.kind == "access", e.is_read == true, do: e.to
    writes = for e <- acc.edges, e.kind == "access", e.is_write == true, do: e.to
    assert {:field, Acme.Order, :lines} in reads
    assert {:field, Acme.Order, :lines} in writes
    assert {:field, Acme.Money, :amount} in writes
  end

  test "an attribute read is an access; raise and reraise are throw sites; apply is dynamic" do
    acc =
      walk("""
      defmodule A do
        @limit 3
        def f(x) do
          if x > @limit, do: raise(Acme.Errors.TooBig, limit: @limit)
          raise "plain"
          apply(x, :run, [])
        rescue
          e in ArgumentError -> reraise e, __STACKTRACE__
        end
      end
      """)

    assert {:attribute, A, :limit} in targets(acc, "A.f#1", "access")
    throws = targets(acc, "A.f#1", "throws")
    assert {:module, Acme.Errors.TooBig} in throws
    assert {:module, RuntimeError} in throws
    assert {:module, ArgumentError} in targets(acc, "A.f#1", "reference")
    assert acc.counts[:dynamic_dispatch] == 1
    assert acc.counts[:throw_dynamic] == 1
  end

  test "GenServer.call on a statically named server dispatches to its handler" do
    acc =
      walk("""
      defmodule A do
        def f, do: GenServer.call(__MODULE__, :ping)
        def g(pid), do: GenServer.cast(pid, :stop)
        def h, do: GenServer.cast(Acme.Stock, :stop)
      end
      """)

    assert {"invocation", {:handler, A, {:handle_call, 3}}, "dynamic-candidate"} in edges(acc, "A.f#0")

    assert {"invocation", {:handler, Acme.Stock, {:handle_cast, 2}}, "dynamic-candidate"} in edges(
             acc,
             "A.h#0"
           )

    refute Enum.any?(edges(acc, "A.g#1"), &match?({_, {:handler, _, _}, _}, &1))
    assert acc.counts[:dynamic_dispatch] == 1
  end

  test "a module used as a value is a reference; a map field access and a call through a variable are dropped" do
    acc =
      walk("""
      defmodule A do
        def f(mod, m) do
          Supervisor.start_link([Acme.Worker, {Acme.Other, []}], strategy: :one_for_one)
          m.name
          mod.run(1)
        end
      end
      """)

    refs = targets(acc, "A.f#2", "reference")
    assert {:module, Acme.Worker} in refs
    assert {:module, Acme.Other} in refs
    assert acc.counts[:map_access] == 1
    assert acc.counts[:dynamic_dispatch] == 1
  end

  test "quote blocks write nothing; a scoped alias applies to what follows it in the body" do
    acc =
      walk("""
      defmodule A do
        defmacro m do
          quote do
            Acme.Hidden.call()
          end
        end

        def f do
          alias Acme.Long.Name
          Name.go()
        end
      end
      """)

    assert edges(acc, "A.m#0") == []
    assert {:function, Acme.Long.Name, :go, 0} in targets(acc, "A.f#0", "invocation")
  end

  test "use is an import plus an invocation of __using__/1; @derive is a generated implementation" do
    acc =
      walk("""
      defmodule A do
        use Acme.Base, opt: 1
        @derive {Jason.Encoder, only: [:a]}
        @derive [Inspect]
        defstruct [:a]
      end
      """)

    assert {"invocation", {:function, Acme.Base, :__using__, 1}, "declared"} in edges(acc, "x.ex/A")
    assert {"interfaceImplementation", {:module, Jason.Encoder}, "generated"} in edges(acc, "x.ex/A")
    assert {"interfaceImplementation", {:module, Inspect}, "generated"} in edges(acc, "x.ex/A")
  end

  test "a script's top level writes edges from the file" do
    acc = walk("import Config\nconfig :app, Acme.Repo, pool: 5\n", "config/config.exs")

    assert Enum.any?(
             targets(acc, "config%2Fconfig.exs", "invocation"),
             &match?({:local, nil, :config, 3, _}, &1)
           )

    assert {:module, Acme.Repo} in targets(acc, "config%2Fconfig.exs", "reference")
  end
end
