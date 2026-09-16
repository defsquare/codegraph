defmodule CodegraphElixir.TraceTest do
  use ExUnit.Case

  import CodegraphElixir.Test.Harness
  alias CodegraphElixir.{CLI, Extraction, Options, Progress, Trace}

  @moduledoc """
  The `--trace` enrichment end to end, without Mix: the tracer records what
  the compiler binds after expansion for a corpus compiled in this VM, the
  trace is written and read back, and the extraction over the same source
  gains `generated` edges for what the parser could not see — a call in
  `use`-injected code and a local the injected import provides.
  """

  @corpus %{
    "lib/base.ex" => """
    defmodule TraceCorpus.Base do
      defmacro __using__(_opts) do
        quote do
          import TraceCorpus.Helpers
          def greet(name), do: shout(name)
        end
      end
    end
    """,
    "lib/helpers.ex" => """
    defmodule TraceCorpus.Helpers do
      def shout(text), do: String.upcase(text)
    end
    """,
    "lib/user.ex" => """
    defmodule TraceCorpus.User do
      use TraceCorpus.Base
      defstruct [:name]

      def run(name) do
        %__MODULE__{name: greet(name)}
      end
    end
    """
  }

  setup_all do
    scratch = Path.join(System.tmp_dir!(), "codegraph-ex-trace-#{System.unique_integer([:positive])}")

    for {rel, source} <- @corpus do
      path = Path.join(scratch, rel)
      File.mkdir_p!(Path.dirname(path))
      File.write!(path, source)
    end

    # Compile the corpus in this VM under the tracer — what `mix codegraph.trace` does with `mix compile`.
    Trace.start()
    tracers = Code.get_compiler_option(:tracers)
    Code.put_compiler_option(:tracers, [Trace.Tracer | tracers])

    try do
      for rel <- ["lib/helpers.ex", "lib/base.ex", "lib/user.ex"] do
        path = Path.join(scratch, rel)
        Code.compile_string(File.read!(path), path)
      end
    after
      Code.put_compiler_option(:tracers, tracers)
    end

    trace_path = Path.join(scratch, "codegraph-trace.jsonl")
    count = Trace.write(trace_path, scratch)
    Trace.stop()

    on_exit(fn ->
      for module <- [TraceCorpus.Base, TraceCorpus.Helpers, TraceCorpus.User] do
        :code.purge(module)
        :code.delete(module)
      end

      File.rm_rf!(scratch)
    end)

    %{scratch: scratch, trace: trace_path, count: count}
  end

  defp extract(scratch, args) do
    {:ok, options} = Options.parse(["--src", ".", "--progress", "none" | args], scratch)
    Extraction.run(options, Progress.silent(), CLI.version(), scratch)
  end

  test "the trace file has a header and one sorted event per resolved site", %{trace: trace, count: count} do
    assert count > 0
    {:ok, read} = Trace.read(trace)
    assert length(read.events) == count
    assert read.elixir == System.version()
    # The `use`-expanded call `shout/1` inside the injected `greet/1` is recorded in user.ex.
    assert Enum.any?(
             read.events,
             &(&1.kind == :imported and &1.to == {TraceCorpus.Helpers, :shout, 1} and &1.file == "lib/user.ex")
           )

    # A struct expansion is an event too.
    assert Enum.any?(read.events, &(&1.kind == :struct and &1.to == TraceCorpus.User))
  end

  test "without the trace, the injected calls are counted, never guessed", %{scratch: scratch} do
    result = extract(scratch, [])
    assert result.stats.dropped[:local_injected] == 1

    refute edge?(
             result.model,
             "invocation",
             "ex:lib%2Fuser.ex/TraceCorpus%2EUser.run#1",
             "ex:lib%2Fhelpers.ex/TraceCorpus%2EHelpers.shout#1"
           )
  end

  test "with the trace, what the compiler bound becomes generated edges and keys never change", %{
    scratch: scratch,
    trace: trace
  } do
    baseline = extract(scratch, [])
    result = extract(scratch, ["--trace", trace])

    corpus_keys = fn model -> for e <- model.entities, e.is_stub != true, do: e.key end
    assert corpus_keys.(baseline.model) == corpus_keys.(result.model)
    assert result.stats.trace.added > 0
    assert result.stats.trace.dropped == 0
    # `run/1` calls the injected `greet/1`: a target with no entity, counted, never invented.
    assert result.stats.trace.injected == 1

    generated = Enum.filter(result.model.edges, &(&1.provenance == "generated"))
    render = &{&1.kind, CodegraphElixir.Model.Key.render(&1.from), CodegraphElixir.Model.Key.render(&1.to)}
    facts = Enum.map(generated, render)

    # `greet/1` is injected into User: the compiler saw `run/1` call it (attributed to the module, which owns injected code)
    # and the injected `greet/1` call `shout/1` through the injected import.
    assert {"invocation", "ex:lib%2Fuser.ex/TraceCorpus%2EUser",
            "ex:lib%2Fhelpers.ex/TraceCorpus%2EHelpers.shout#1"} in facts

    # `use` itself was already a declared invocation of `__using__/1`: the trace adds nothing there.
    assert Enum.count(
             result.model.edges,
             &(&1.kind == "invocation" and
                 render.(&1) |> elem(2) == "ex:lib%2Fbase.ex/TraceCorpus%2EBase.__using__#1")
           ) == 1

    # Every declared edge of the baseline is still there, unchanged.
    for edge <- baseline.model.edges, do: assert(edge in result.model.edges)
  end
end
