defmodule CodegraphElixir.Measures do
  @moduledoc """
  Measures (TMetrics, METAMODEL.md §3.8): `sloc`, the lines of a span that
  are neither blank nor comment-only — a comment being what the compiler's
  own parser reports as one, so a `#` inside a heredoc or a sigil is text —
  and `cyclomatic`, 1 + the branches the profile note lists. A nested `fn`
  contributes to its enclosing invocable: an anonymous function is not an
  entity.
  """

  @doc """
  The set of 1-based lines that are neither blank nor comment-only.
  `comments` are the parser's (`Code.string_to_quoted_with_comments`), by
  line, as `{column, text}`: a line whose only content is one of them is a
  comment line. Every other non-blank line is code — including each line a
  heredoc, a sigil or a multi-line string spans.
  """
  def code_lines(source, comments) do
    source
    |> String.split("\n")
    |> Enum.with_index(1)
    |> Enum.reject(fn {text, line} -> blank?(text) or comment_only?(text, Map.get(comments, line)) end)
    |> MapSet.new(fn {_, line} -> line end)
  end

  defp blank?(text), do: String.trim(text) == ""

  defp comment_only?(_text, nil), do: false
  defp comment_only?(text, {column, _}), do: text |> String.slice(0, column - 1) |> String.trim() == ""

  def sloc(code_lines, {start_line, end_line}) do
    Enum.count(start_line..end_line//1, &MapSet.member?(code_lines, &1))
  end

  @doc "1 + branches of one clause body (the fold adds one per clause beyond the first)."
  def cyclomatic(body) do
    {_, count} =
      Macro.prewalk(body, 0, fn
        {form, _, [_, _]} = node, acc when form in [:and, :or, :&&, :||] ->
          {node, acc + 1}

        {form, _, _} = node, acc when form in [:if, :unless] ->
          {node, acc + 1}

        {form, _, args} = node, acc when form in [:case, :cond, :receive] and is_list(args) ->
          {node, acc + clauses(args) - 1}

        {:with, _, args} = node, acc when is_list(args) ->
          {node, acc + Enum.count(args, &match?({:<-, _, _}, &1))}

        {:try, _, args} = node, acc when is_list(args) ->
          {node, acc + rescue_clauses(args)}

        # `fn` clauses beyond the first branch too.
        {:fn, _, clauses} = node, acc when is_list(clauses) ->
          {node, acc + max(length(clauses) - 1, 0)}

        node, acc ->
          {node, acc}
      end)

    1 + count
  end

  defp clauses(args) do
    args
    |> Enum.filter(&Keyword.keyword?/1)
    |> List.flatten()
    |> Enum.flat_map(fn
      {:do, list} when is_list(list) -> list
      _ -> []
    end)
    |> Enum.count(&match?({:->, _, _}, &1))
    |> max(1)
  end

  defp rescue_clauses(args) do
    args
    |> Enum.filter(&Keyword.keyword?/1)
    |> List.flatten()
    |> Enum.flat_map(fn
      {key, list} when key in [:rescue, :catch] and is_list(list) -> list
      _ -> []
    end)
    |> Enum.count(&match?({:->, _, _}, &1))
  end
end
