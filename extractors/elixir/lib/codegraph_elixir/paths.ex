defmodule CodegraphElixir.Paths do
  @moduledoc """
  Paths as the model writes them: `/`-separated on every OS, root-relative,
  compared by UTF-16 code unit. The file table is sorted by these strings, and
  a Windows `\\` or a case-folding comparison would change every surrogate.
  """

  def slashes(path), do: String.replace(path, "\\", "/")

  @doc "The typed path with `/` separators and no trailing slash — the header's `root`."
  def display(typed) do
    text = typed |> slashes() |> String.trim_trailing("/")
    if text == "", do: ".", else: text
  end

  @doc "Absolute, normalised, `/`-separated — the form every path is compared in."
  def absolute(path, cwd), do: path |> Path.expand(cwd) |> slashes()

  def relative_to(root_full, file_full) do
    rel = file_full |> Path.relative_to(root_full) |> slashes()

    if String.starts_with?(rel, "..") or Path.type(rel) == :absolute do
      raise ArgumentError, "#{file_full} is not under #{root_full}"
    end

    rel
  end

  @doc "Deepest common ancestor of absolute directories — one root, no absolute anchor."
  def common_root([first | rest]) do
    Enum.reduce(rest, first, fn candidate, common -> climb(candidate, common) end)
  end

  defp climb(candidate, common) do
    if under?(candidate, common) do
      common
    else
      parent = Path.dirname(common)
      if parent == common, do: common, else: climb(candidate, parent)
    end
  end

  def under?(full, root),
    do: full == root or String.starts_with?(full, String.trim_trailing(root, "/") <> "/")
end
