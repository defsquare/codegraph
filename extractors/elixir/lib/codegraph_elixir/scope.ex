defmodule CodegraphElixir.Scope do
  @moduledoc """
  The lexical resolver: an alias table (`alias A.B`, `alias A.B, as: C`,
  `require A, as: B`, nested `defmodule` auto-aliases) plus the current
  module for `__MODULE__`. Resolution of an `__aliases__` node follows the
  compiler's rule — the first segment is looked up in the table, the rest
  is concatenated — and yields `nil` for anything dynamic (`unquote`, a
  variable), which the caller counts as a dropped dynamic module name.
  """

  defstruct aliases: %{}, module: nil

  @type t :: %__MODULE__{aliases: %{atom() => atom()}, module: atom() | nil}

  def new, do: %__MODULE__{}

  def enter_module(%__MODULE__{} = scope, module), do: %__MODULE__{scope | module: module}

  @doc "`alias Full` (or `as: Name`): `Name` resolves to `Full` from here on."
  def add_alias(%__MODULE__{} = scope, full, as) when is_atom(full) and is_atom(as) do
    %__MODULE__{scope | aliases: Map.put(scope.aliases, as, full)}
  end

  @doc "The alias a bare `alias A.B.C` creates: its last segment."
  def last_segment(module) when is_atom(module) do
    module |> Module.split() |> List.last() |> String.to_atom()
  end

  @doc "Resolve a module-naming AST node to an atom, or nil when it is not static."

  def resolve(scope, {:__aliases__, _meta, [first | rest]}) do
    base =
      case first do
        :"Elixir" -> {:ok, nil}
        {:__MODULE__, _, ctx} when is_atom(ctx) -> if scope.module, do: {:ok, scope.module}, else: :error
        segment when is_atom(segment) -> {:ok, Map.get(scope.aliases, segment, Module.concat([segment]))}
        _ -> :error
      end

    with {:ok, base_atom} <- base,
         true <- Enum.all?(rest, &is_atom/1) do
      if base_atom == nil, do: Module.concat(rest), else: Module.concat([base_atom | rest])
    else
      _ -> nil
    end
  end

  def resolve(scope, {:__MODULE__, _meta, ctx}) when is_atom(ctx), do: scope.module
  def resolve(_scope, atom) when is_atom(atom) and not is_boolean(atom) and atom != nil, do: atom
  def resolve(_scope, _other), do: nil

  @doc "Elixir-side name of a module atom: `Acme.Order`, or `ets` for an Erlang module."
  def module_name(module) when is_atom(module) do
    case Atom.to_string(module) do
      "Elixir." <> rest -> rest
      other -> other
    end
  end
end
