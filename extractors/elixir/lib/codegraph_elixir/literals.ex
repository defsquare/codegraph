defmodule CodegraphElixir.Literals do
  @moduledoc """
  The value door (METAMODEL.md §1.6): a written, declaration-site value — a
  struct field's default, a module attribute's value, a parameter's `\\\\`
  default. What is emitted is exactly what is written: strings, numbers,
  booleans, nil, a module used as a value (a `type` literal, closed against
  the model), lists of those; anything else constant-shaped (an atom, a
  keyword list, a tuple, a map, a sigil) rides as `unevaluated` with its
  source text. Code — a call, a `fn`, a comprehension — carries no value at
  all: absence is a claim, the C# rule.
  """

  alias CodegraphElixir.Scope

  @doc "A value, or nil when the expression is code."
  def value_of(ast, %Scope{} = scope) do
    if constant?(ast), do: literal(ast, scope), else: nil
  end

  @doc "The literal of a constant-shaped expression."
  def literal(ast, scope)
  def literal(text, _scope) when is_binary(text), do: %{k: "string", v: text}
  def literal(int, _scope) when is_integer(int), do: %{k: "number", v: Integer.to_string(int)}
  def literal(float, _scope) when is_float(float), do: %{k: "number", v: number_text(float)}
  def literal(true, _scope), do: %{k: "boolean", v: true}
  def literal(false, _scope), do: %{k: "boolean", v: false}
  def literal(nil, _scope), do: %{k: "null"}
  def literal({:__aliases__, _, _} = ast, scope), do: module_literal(ast, scope)
  def literal({:__MODULE__, _, ctx} = ast, scope) when is_atom(ctx), do: module_literal(ast, scope)
  def literal({:-, _, [n]}, scope) when is_number(n), do: literal(-n, scope)

  def literal(list, scope) when is_list(list) do
    if Keyword.keyword?(list) and list != [] do
      unevaluated(list)
    else
      %{k: "array", items: Enum.map(list, &literal(&1, scope))}
    end
  end

  def literal(ast, _scope), do: unevaluated(ast)

  defp module_literal(ast, scope) do
    case Scope.resolve(scope, ast) do
      nil -> unevaluated(ast)
      module -> %{k: "type", type: {:module, module}}
    end
  end

  defp unevaluated(ast) do
    source = ast |> Macro.to_string() |> String.replace(~r/\s+/, " ") |> String.trim()
    %{k: "unevaluated", source: if(source == "", do: "?", else: source)}
  end

  @doc "Constant-shaped: literals, atoms, module names, negation, lists/tuples/maps/keywords of those, sigils."
  def constant?(ast)
  def constant?(value) when is_binary(value) or is_number(value) or is_atom(value), do: true
  def constant?({:__aliases__, _, parts}), do: Enum.all?(parts, &is_atom/1)
  def constant?({:__MODULE__, _, ctx}) when is_atom(ctx), do: true
  def constant?({:-, _, [n]}) when is_number(n), do: true
  def constant?({:{}, _, items}), do: Enum.all?(items, &constant?/1)
  def constant?({:%{}, _, pairs}), do: Enum.all?(pairs, &constant?/1)
  def constant?({:<<>>, _, parts}), do: Enum.all?(parts, &is_binary/1)

  def constant?({sigil, _, [{:<<>>, _, parts}, _mods]}) when is_atom(sigil),
    do: sigil?(sigil) and Enum.all?(parts, &is_binary/1)

  def constant?({a, b}), do: constant?(a) and constant?(b)
  def constant?(list) when is_list(list), do: Enum.all?(list, &constant?/1)
  def constant?(_), do: false

  defp sigil?(name), do: String.starts_with?(Atom.to_string(name), "sigil_")

  # JavaScript's shortest round-trip text for a float; integral floats print as integers.
  defp number_text(float) do
    if float == Float.floor(float) and abs(float) < 1.0e21 do
      float |> trunc() |> Integer.to_string()
    else
      :erlang.float_to_binary(float, [:short])
    end
  end
end
