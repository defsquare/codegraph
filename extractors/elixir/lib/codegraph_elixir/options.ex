defmodule CodegraphElixir.Options do
  @moduledoc """
  The extractor command-line contract (schemas/README.md §8), shared with the
  Java jar, the C# binary and the TypeScript bin so `codegraph snapshots
  --extractor` can drive any of them, plus the Elixir flags of PLAN.md §16.5.
  """

  defstruct sources: [],
            out: nil,
            progress: :auto,
            repository: nil,
            deps: nil,
            trace: nil,
            explain_dropped: false,
            help: false,
            version: false

  @type t :: %__MODULE__{}

  @https_remote ~r"^https://(?![^\s]*\.git$)[^\s?#]*[^\s?#/]$"
  @sha ~r"^[0-9a-f]{7,64}$"
  @relative_path ~r"^$|^(?!\.\.?(?:/|$))[^/\s]+(?:/(?!\.\.?(?:/|$))[^/\s]+)*$"

  @spec parse([String.t()], String.t()) :: {:ok, t()} | {:error, String.t()}
  def parse(argv, cwd) do
    with {:ok, acc} <-
           walk(argv, %{
             sources: [],
             out: nil,
             progress: :auto,
             repo: %{},
             deps: nil,
             trace: nil,
             explain_dropped: false,
             help: false,
             version: false
           }),
         {:ok, repository} <- repository(acc.repo) do
      sources = if acc.sources == [], do: ["."], else: Enum.reverse(acc.sources)

      {:ok,
       %__MODULE__{
         sources: sources,
         out: acc.out || "#{Path.basename(cwd)}-codegraph.jsonl",
         progress: acc.progress,
         repository: repository,
         deps: acc.deps,
         trace: acc.trace,
         explain_dropped: acc.explain_dropped,
         help: acc.help,
         version: acc.version
       }}
    end
  end

  defp walk([], acc), do: {:ok, acc}
  defp walk(["--src", value | rest], acc), do: walk(rest, %{acc | sources: [value | acc.sources]})
  defp walk(["--out", value | rest], acc), do: walk(rest, %{acc | out: value})

  defp walk(["--progress", value | rest], acc) do
    case value do
      "auto" -> walk(rest, %{acc | progress: :auto})
      "plain" -> walk(rest, %{acc | progress: :plain})
      "none" -> walk(rest, %{acc | progress: :none})
      other -> {:error, "--progress must be auto, plain or none, got: #{other}"}
    end
  end

  defp walk(["--no-progress" | rest], acc), do: walk(rest, %{acc | progress: :none})
  defp walk(["--repo-remote", value | rest], acc), do: walk(rest, put_in(acc.repo[:remote], value))
  defp walk(["--repo-commit", value | rest], acc), do: walk(rest, put_in(acc.repo[:commit], value))
  defp walk(["--repo-root", value | rest], acc), do: walk(rest, put_in(acc.repo[:root], value))
  defp walk(["--repo-provider", value | rest], acc), do: walk(rest, put_in(acc.repo[:provider], value))
  defp walk(["--deps", value | rest], acc), do: walk(rest, %{acc | deps: value})
  defp walk(["--trace", value | rest], acc), do: walk(rest, %{acc | trace: value})
  defp walk(["--explain-dropped" | rest], acc), do: walk(rest, %{acc | explain_dropped: true})
  defp walk([flag | rest], acc) when flag in ["--help", "-h"], do: walk(rest, %{acc | help: true})
  defp walk(["--version" | rest], acc), do: walk(rest, %{acc | version: true})

  defp walk([flag], _acc)
       when flag in ~w(--src --out --progress --repo-remote --repo-commit --repo-root --repo-provider --deps --trace),
       do: {:error, "#{flag} needs a value"}

  defp walk([other | _], _acc), do: {:error, "unknown option: #{other}"}

  # `--repo-remote`, `--repo-commit` and `--repo-root` go together; copied
  # verbatim into the header after a shape check — the extractor invents nothing.
  defp repository(repo) when map_size(repo) == 0, do: {:ok, nil}

  defp repository(repo) do
    cond do
      not (Map.has_key?(repo, :remote) and Map.has_key?(repo, :commit) and Map.has_key?(repo, :root)) ->
        {:error, "--repo-remote, --repo-commit and --repo-root go together (--repo-provider is optional)"}

      not Regex.match?(@https_remote, repo.remote) ->
        {:error, "--repo-remote must be a normalized https URL (no ssh form, no .git): #{repo.remote}"}

      not Regex.match?(@sha, repo.commit) ->
        {:error, "--repo-commit must be a lowercase hex sha: #{repo.commit}"}

      not Regex.match?(@relative_path, repo.root) ->
        {:error, "--repo-root must be a path relative to the repository root: #{repo.root}"}

      Map.has_key?(repo, :provider) and repo.provider not in ["github", "gitlab"] ->
        {:error, "--repo-provider must be github or gitlab, got: #{repo.provider}"}

      true ->
        base = [{"remote", repo.remote}, {"commit", repo.commit}, {"root", repo.root}]
        {:ok, if(Map.has_key?(repo, :provider), do: base ++ [{"provider", repo.provider}], else: base)}
    end
  end

  def usage(version) do
    """
    codegraph-elixir #{version} — Elixir extractor on the compiler's parser

    USAGE
      codegraph-elixir [--src <dir>…] [--out <file>]

    OPTIONS
      --src <dir>           source root to analyze; repeatable. Default: the current
                            directory. With several roots, anchors are relative to
                            their deepest common ancestor, which becomes the model's root.
      --out <file>          where to write the model. Default: <current-dir>-codegraph.jsonl
      --progress <mode>     auto (default: one line per phase on a terminal, nothing
                            when piped), plain, or none
      --no-progress         same as --progress none
      --deps <dir>          parse dependency sources under <dir> for their EXPORTS only
                            (names and arities); keys never change, only counts do.
                            Default: none, even when deps/ exists beside the roots
      --trace <file>        merge the compiler trace `mix codegraph.trace` wrote inside the
                            project: calls the parser cannot see (macro-injected) become
                            `generated` edges; keys never change
      --explain-dropped     list every dropped site on stderr (reason, file:line, name/arity)
      --repo-remote <url>   normalized https clone URL, no .git suffix
      --repo-commit <sha>   the sha this tree is at — a permalink, not a branch
      --repo-root <path>    repo-relative path of the analyzed root ("" at the repo root)
      --repo-provider <p>   github or gitlab, only when the hostname does not say
      --version             print the extractor version
      --help                this text

    Nothing is compiled: every *.ex/*.exs under the roots (_build, deps, .git and
    node_modules excluded) is parsed with the compiler's own parser; names resolve
    through a lexical scope and an embedded table of what the BEAM ships; a module
    the corpus does not declare is a stub. Exit codes: 0 ok, 1 failure, 2 usage,
    3 unimplemented.
    """
  end
end
