defmodule CodegraphElixir.Deps do
  @moduledoc """
  `--deps <dir>` (PLAN.md §16.4): the dependency sources under `<dir>/*/lib`
  parsed for their EXPORTS only — the public names and arities each module
  defines — so an `import Ecto.Query` binds `from/2` as a fact rather than
  an attribution and a call into a dependency counts as resolved. Keys do
  not change: a dependency stays a stub below `<deps>`; no entity is emitted
  from it.
  """

  alias CodegraphElixir.{Corpus, ExtractionError, Paths, Walker}

  @type exports :: %{atom() => MapSet.t({atom(), non_neg_integer()})}

  @spec load(String.t() | nil, String.t()) :: exports()
  def load(nil, _cwd), do: %{}

  def load(dir, cwd) do
    full = Paths.absolute(dir, cwd)

    if not File.dir?(full) do
      raise ExtractionError, "--deps is not a directory: #{full}"
    end

    full
    |> File.ls!()
    |> Enum.map(&Path.join(full, &1))
    |> Enum.filter(&File.dir?(Path.join(&1, "lib")))
    |> Enum.flat_map(&Corpus.walk(Path.join(&1, "lib")))
    |> Enum.reduce(%{}, fn path, exports ->
      file = Corpus.from_source(Paths.relative_to(full, path), path, File.read!(path))
      if file.ast == nil, do: exports, else: merge(exports, Walker.walk(file))
    end)
  end

  defp merge(exports, walked) do
    Enum.reduce(walked.declared, exports, fn declared, exports ->
      public =
        for {{name, arity}, %{private: false, defaults: defaults}} <- declared.functions,
            a <- (arity - defaults)..arity//1,
            do: {name, a}

      Map.update(exports, declared.atom, MapSet.new(public), &MapSet.union(&1, MapSet.new(public)))
    end)
  end

  def exports?(exports, module, name, arity) do
    case Map.fetch(exports, module) do
      {:ok, set} -> MapSet.member?(set, {name, arity})
      :error -> false
    end
  end
end
