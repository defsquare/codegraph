defmodule Mix.Tasks.Codegraph.Trace do
  @shortdoc "Compile the project under a tracer and write the call trace `codegraph-elixir --trace` reads"

  @moduledoc """
  Recompiles the current project (`mix compile --force`) with a compilation
  tracer attached, and writes every call the compiler resolved AFTER macro
  expansion — the calls the parser-only extractor cannot see — to a JSONL
  file (`codegraph-trace.jsonl` by default):

      mix codegraph.trace [--out FILE]

  Then, from wherever the extractor runs:

      codegraph-elixir --src . --trace codegraph-trace.jsonl --out model.jsonl

  The project must compile: this task needs its dependencies fetched and
  compiled, which is exactly what the parser-only baseline does not need.
  Add `{:codegraph_elixir, "~> 0.1", only: :dev, runtime: false}` to the
  project's deps to have the task, or run it from a path dependency.
  """

  use Mix.Task

  alias CodegraphElixir.Trace

  @impl Mix.Task
  def run(args) do
    {opts, _rest} = OptionParser.parse!(args, strict: [out: :string])
    out = Keyword.get(opts, :out, "codegraph-trace.jsonl")

    # `mix compile` prunes the code path to the project's own deps: the tracer
    # must be IN MEMORY before compilation starts, wherever its beam came from.
    Code.ensure_loaded!(Trace)
    Code.ensure_loaded!(Trace.Tracer)
    Trace.start()
    tracers = Code.get_compiler_option(:tracers)
    Code.put_compiler_option(:tracers, [Trace.Tracer | tracers])

    try do
      Mix.Task.run("compile", ["--force"])
      count = Trace.write(out, File.cwd!())
      Mix.shell().info("wrote #{count} events to #{out}")
    after
      Code.put_compiler_option(:tracers, tracers)
      Trace.stop()
    end
  end
end
