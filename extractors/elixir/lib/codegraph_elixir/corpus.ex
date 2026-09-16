defmodule CodegraphElixir.Corpus do
  @moduledoc """
  Pass 0 — the parser without the compiler (PLAN.md §16, principle 1). Walk
  the roots in ordinal order and parse every `*.ex` / `*.exs` with the
  compiler's own parser. Nothing is compiled, `deps/` is never read, and a
  file the parser rejects is skipped and counted — never fatal.
  """

  alias CodegraphElixir.{ExtractionError, Measures, Paths}

  defmodule SourceFile do
    @moduledoc """
    One corpus file: its root-relative path, source, line count, quoted AST
    or parse error, the `#` comments by line, and the lines carrying a token
    (for `sloc`).
    """
    @enforce_keys [:rel, :full, :source, :lines]
    defstruct [:rel, :full, :source, :lines, ast: nil, error: nil, comments: %{}, token_lines: MapSet.new()]
  end

  defstruct [:root, :root_display, :files]

  @skipped_directories MapSet.new(["_build", "deps", ".git", "node_modules", ".elixir_ls"])
  @extensions [".ex", ".exs"]

  def load(sources, cwd) do
    roots_full = Enum.map(sources, &Paths.absolute(&1, cwd))

    for root <- roots_full, not File.dir?(root) do
      raise ExtractionError, "source root is not a directory: #{root}"
    end

    root = Paths.common_root(roots_full)

    root_display =
      case sources do
        [single] ->
          Paths.display(single)

        _ ->
          if Paths.under?(root, Paths.absolute(".", cwd)),
            do: Paths.relative_to(Paths.absolute(".", cwd), root),
            else: root
      end

    files =
      roots_full
      |> Enum.flat_map(&walk/1)
      |> Enum.uniq()
      |> Enum.map(fn full -> {Paths.relative_to(root, full), full} end)
      |> Enum.sort_by(fn {rel, _} -> CodegraphElixir.Model.Key.utf16(rel) end)
      |> Enum.map(fn {rel, full} -> parse(rel, full) end)

    %__MODULE__{root: root, root_display: root_display, files: files}
  end

  @doc "Every `.ex`/`.exs` below a directory, build output and dependencies skipped."
  def walk(directory) do
    directory
    |> File.ls!()
    |> Enum.flat_map(fn entry ->
      full = Paths.slashes(Path.join(directory, entry))

      cond do
        File.dir?(full) -> if MapSet.member?(@skipped_directories, entry), do: [], else: walk(full)
        Path.extname(entry) in @extensions -> [full]
        true -> []
      end
    end)
  end

  defp parse(rel, full), do: from_source(rel, full, File.read!(full))

  @doc "A corpus file from its text — what the walker tests feed in."
  def from_source(rel, full \\ nil, source) do
    file = %SourceFile{rel: rel, full: full || rel, source: source, lines: line_count(source)}

    if String.valid?(source) do
      case Code.string_to_quoted_with_comments(source,
             columns: true,
             token_metadata: true,
             file: rel,
             emit_warnings: false
           ) do
        {:ok, ast, comments} ->
          %SourceFile{
            file
            | ast: ast,
              comments: Map.new(comments, fn c -> {c.line, {c.column, c.text}} end),
              token_lines: Measures.token_lines(source)
          }

        {:error, {meta, message, token}} ->
          %SourceFile{file | error: format_error(meta, message, token)}
      end
    else
      %SourceFile{file | error: "not valid UTF-8"}
    end
  end

  defp line_count(source) do
    lines = source |> String.split("\n") |> length()
    if String.ends_with?(source, "\n"), do: max(1, lines - 1), else: lines
  end

  defp format_error(meta, message, token) do
    line = if is_list(meta), do: Keyword.get(meta, :line, 0), else: 0
    text = if is_binary(message), do: message, else: inspect(message)
    "line #{line}: #{text}#{token}"
  end
end
