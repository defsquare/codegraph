defmodule CodegraphElixir.Test.Harness do
  @moduledoc "One extraction of the fixture in-process, silent; the CLI in-process with both streams captured."

  alias CodegraphElixir.{CLI, Extraction, Options, Progress}

  @fixture_src "fixtures/elixir/src"

  @doc "The repo root, found by walking up — these tests run from worktrees too."
  def repo_root, do: find_up(__DIR__)

  defp find_up(directory) do
    if File.exists?(Path.join(directory, "pnpm-workspace.yaml")) and
         File.dir?(Path.join(directory, "fixtures")) do
      directory
    else
      parent = Path.dirname(directory)
      if parent == directory, do: raise("repo root not found"), else: find_up(parent)
    end
  end

  def fixture_src, do: @fixture_src
  def snapshot, do: Path.join(repo_root(), "fixtures/elixir/expected/model.jsonl")

  def extract_fixture(sources \\ [@fixture_src], cwd \\ repo_root()) do
    {:ok, options} = Options.parse(Enum.flat_map(sources, &["--src", &1]) ++ ["--progress", "none"], cwd)
    Extraction.run(options, Progress.silent(), CLI.version(), cwd)
  end

  @doc "The CLI in-process, both streams captured separately."
  def invoke(args, cwd \\ repo_root()) do
    {:ok, sink} = Agent.start_link(fn -> %{stdout: [], stderr: []} end)

    io = %CLI.Io{
      stdout: fn text -> Agent.update(sink, &%{&1 | stdout: [&1.stdout, text]}) end,
      stderr: fn text -> Agent.update(sink, &%{&1 | stderr: [&1.stderr, text]}) end
    }

    code = CLI.run(args, io, cwd)
    captured = Agent.get(sink, & &1)
    Agent.stop(sink)
    %{code: code, stdout: IO.iodata_to_binary(captured.stdout), stderr: IO.iodata_to_binary(captured.stderr)}
  end

  @doc "The entity rendered as `id`, or nil."
  def find(model, id) do
    Enum.find(model.entities, &(CodegraphElixir.Model.Key.render(&1.key) == id))
  end

  def ids(model), do: MapSet.new(model.entities, &CodegraphElixir.Model.Key.render(&1.key))

  def edge?(model, kind, from, to) do
    Enum.any?(model.edges, fn edge ->
      edge.kind == kind and CodegraphElixir.Model.Key.render(edge.from) == from and
        CodegraphElixir.Model.Key.render(edge.to) == to
    end)
  end
end
