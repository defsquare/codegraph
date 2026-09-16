defmodule CodegraphElixir.DepsTest do
  use ExUnit.Case, async: true

  import CodegraphElixir.Test.Harness
  alias CodegraphElixir.{CLI, Extraction, Options, Progress}

  @moduledoc """
  `--deps <dir>`: dependency sources are read for their EXPORTS only. A
  local call an import provides binds as a fact; a call into a dependency
  that exports it counts as resolved; keys never change and no entity is
  emitted from the dependency.
  """

  setup_all do
    scratch = Path.join(System.tmp_dir!(), "codegraph-ex-deps-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(scratch, "lib"))
    File.mkdir_p!(Path.join(scratch, "deps/acme_query/lib"))

    File.write!(Path.join(scratch, "lib/finder.ex"), """
    defmodule Finder do
      import AcmeQuery
      def all(t), do: from(t) |> AcmeQuery.run(1)
      def none(t), do: missing(t)
    end
    """)

    File.write!(Path.join(scratch, "deps/acme_query/lib/acme_query.ex"), """
    defmodule AcmeQuery do
      def from(t), do: t
      def run(q, n \\\\ 0), do: {q, n}
      defp secret, do: :no
    end
    """)

    on_exit(fn -> File.rm_rf!(scratch) end)
    %{scratch: scratch}
  end

  defp extract(scratch, args) do
    {:ok, options} = Options.parse(["--src", "lib", "--progress", "none" | args], scratch)
    Extraction.run(options, Progress.silent(), CLI.version(), scratch)
  end

  test "with the dependency's exports, imported and remote names resolve and unknown ones are dropped", %{
    scratch: scratch
  } do
    result = extract(scratch, ["--deps", "deps"])
    assert edge?(result.model, "invocation", "ex:finder.ex/Finder.all#1", "ex:<deps>/AcmeQuery")
    # `missing/1`: the import's exports are known and do not provide it.
    assert result.stats.dropped[:local_unbound] == 1
    refute edge?(result.model, "invocation", "ex:finder.ex/Finder.none#1", "ex:<deps>/AcmeQuery")
    # Nothing from deps/ is corpus.
    refute Enum.any?(
             result.model.entities,
             &(&1.kind == "module" and &1.name == "AcmeQuery" and &1.is_stub == false)
           )
  end

  test "without it, the sole foreign import is attributed and a foreign remote call is trusted", %{
    scratch: scratch
  } do
    result = extract(scratch, [])
    assert edge?(result.model, "invocation", "ex:finder.ex/Finder.all#1", "ex:<deps>/AcmeQuery")
    # `missing/1` is attributed to the only import that could provide it.
    assert edge?(result.model, "invocation", "ex:finder.ex/Finder.none#1", "ex:<deps>/AcmeQuery")
    refute Map.has_key?(result.stats.dropped, :local_unbound)
  end

  test "a directory that is not there is an error", %{scratch: scratch} do
    assert %{code: 1, stderr: stderr} =
             invoke(["--src", "lib", "--deps", "nowhere", "--out", Path.join(scratch, "o.jsonl")], scratch)

    assert stderr =~ "--deps is not a directory"
  end
end
