defmodule CodegraphElixir.Measures do
  @moduledoc """
  Measures (TMetrics, METAMODEL.md §3.8): `sloc`, the lines of a span that
  carry at least one token — counted with the compiler's own tokenizer, so
  a heredoc or a sigil cannot swallow a comment marker — and `cyclomatic`,
  1 + the branches the profile note lists. A nested `fn` contributes to its
  enclosing invocable: an anonymous function is not an entity.
  """

  @doc "The set of 1-based lines carrying a token; empty when the source does not tokenize."
  def token_lines(source) do
    case :elixir_tokenizer.tokenize(String.to_charlist(source), 1, []) do
      {:ok, _line, _column, _warnings, tokens, _terminators} ->
        tokens
        |> Enum.reject(fn token -> elem(token, 0) == :eol end)
        |> Enum.map(fn token -> elem(elem(token, 1), 0) end)
        |> MapSet.new()

      _ ->
        MapSet.new()
    end
  end

  def sloc(token_lines, {start_line, end_line}) do
    Enum.count(start_line..end_line//1, &MapSet.member?(token_lines, &1))
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
