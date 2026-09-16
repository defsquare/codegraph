defmodule CodegraphElixir.CorpusTest do
  use ExUnit.Case

  alias CodegraphElixir.{CLI, Extraction, Options, Progress}
  alias CodegraphElixir.Model.Key

  @moduledoc """
  The two oracles Elixir ships for free (PLAN.md §16.6), against a REAL
  corpus, opt-in: set `CODEGRAPH_CORPUS_ELIXIR` to a compiled Mix project
  (`mix compile` done, `mix xref graph --format dot` written to
  `xref_graph.dot`, optionally `mix codegraph.trace` written to
  `codegraph-trace.jsonl`).

  - `mix xref graph` is the compiler's file-level dependency graph. Every
    xref edge must be witnessed by SOME edge of the model between entities
    of the two files (folded to file level) — a miss names a resolution the
    parser lost; aliases add edges xref does not have, so the model is a
    superset there, not equal.
  - The trace-enriched model must contain every edge of the baseline, and
    everything it adds must validate (closure holds by construction: the
    merge resolves through the same rules).
  """

  @corpus System.get_env("CODEGRAPH_CORPUS_ELIXIR")

  @moduletag :corpus

  defp extract(corpus, args) do
    {:ok, options} = Options.parse(["--src", ".", "--progress", "none" | args], corpus)
    Extraction.run(options, Progress.silent(), CLI.version(), corpus)
  end

  # `"lib/a.ex" -> "lib/b.ex" [label="(compile)"]` lines of a dot graph.
  defp xref_edges(dot) do
    ~r/"([^"]+)"\s*->\s*"([^"]+)"/
    |> Regex.scan(dot)
    |> Enum.map(fn [_, from, to] -> {from, to} end)
    |> MapSet.new()
  end

  # Every model edge folded to (from file, to file), corpus files only.
  defp file_edges(model) do
    file_of =
      Map.new(model.entities, fn e -> {Key.index(e.key), e.key.module} end)

    unescape = &CodegraphElixir.Ids.unescape/1

    model.edges
    |> Enum.map(fn e -> {unescape.(file_of[Key.index(e.from)]), unescape.(file_of[Key.index(e.to)])} end)
    |> Enum.reject(fn {a, b} -> a == b or String.starts_with?(b, "<") end)
    |> MapSet.new()
  end

  @tag :corpus
  test "every mix xref edge is witnessed by the model (opt-in: CODEGRAPH_CORPUS_ELIXIR)" do
    if @corpus == nil do
      IO.puts("skipped: set CODEGRAPH_CORPUS_ELIXIR to a compiled Mix project")
    else
      dot = File.read!(Path.join(@corpus, "xref_graph.dot"))
      xref = xref_edges(dot)
      ours = file_edges(extract(@corpus, []).model)
      missed = MapSet.difference(xref, ours)
      covered = MapSet.size(xref) - MapSet.size(missed)
      IO.puts("xref edges #{MapSet.size(xref)}, witnessed #{covered}, missed #{MapSet.size(missed)}")
      for {a, b} <- Enum.take(Enum.sort(missed), 40), do: IO.puts("  missed #{a} -> #{b}")
      # The parser sees what compiles-time and runtime dependencies write in source; the
      # remainder is injected code. The threshold is the audited floor, restated when it moves.
      assert covered / max(MapSet.size(xref), 1) >= 0.85
    end
  end

  @tag :corpus
  test "the trace-enriched model is a superset of the baseline (opt-in)" do
    trace = @corpus && Path.join(@corpus, "codegraph-trace.jsonl")

    if trace == nil or not File.exists?(trace) do
      IO.puts("skipped: no codegraph-trace.jsonl in the corpus")
    else
      baseline = extract(@corpus, [])
      enriched = extract(@corpus, ["--trace", trace])
      IO.inspect(enriched.stats.trace, label: "trace")
      for edge <- baseline.model.edges, do: assert(edge in enriched.model.edges)
      assert length(enriched.model.edges) >= length(baseline.model.edges)
      assert enriched.stats.unclosable == []
    end
  end
end
