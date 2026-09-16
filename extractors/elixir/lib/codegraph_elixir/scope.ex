defmodule CodegraphElixir.Scope do
  @moduledoc """
  The lexical resolver: an alias table (`alias A.B`, `alias A.B, as: C`,
  `require A, as: B`, nested `defmodule` auto-aliases), the imports in force
  (`import M`, `only:`/`except:`, `import Kernel, except:`), and the current
  module for `__MODULE__`. Resolution of an `__aliases__` node follows the
  compiler's rule — the first segment is looked up in the table, the rest
  is concatenated — and yields `nil` for anything dynamic (`unquote`, a
  variable), which the caller counts as a dropped dynamic module name.
  """

  defstruct aliases: %{}, module: nil, imports: [], kernel: :all, uses: []

  @type import_spec ::
          :all | {:only, [{atom(), non_neg_integer()}]} | {:except, [{atom(), non_neg_integer()}]}
  @type t :: %__MODULE__{
          aliases: %{atom() => atom()},
          module: atom() | nil,
          imports: [{atom(), import_spec()}],
          kernel: import_spec()
        }

  def new, do: %__MODULE__{}

  def enter_module(%__MODULE__{} = scope, module), do: %__MODULE__{scope | module: module}

  @doc "`alias Full` (or `as: Name`): `Name` resolves to `Full` from here on."
  def add_alias(%__MODULE__{} = scope, full, as) when is_atom(full) and is_atom(as) do
    %__MODULE__{scope | aliases: Map.put(scope.aliases, as, full)}
  end

  @doc "`import M` with its `only:`/`except:` as written; `import Kernel, …` restricts the implicit import."
  def add_import(%__MODULE__{} = scope, Kernel, spec), do: %__MODULE__{scope | kernel: spec}

  def add_import(%__MODULE__{} = scope, module, spec) when is_atom(module) do
    %__MODULE__{scope | imports: [{module, spec} | Enum.reject(scope.imports, &(elem(&1, 0) == module))]}
  end

  @doc "`use X`: a module whose `__using__` may inject imports and definitions."
  def add_use(%__MODULE__{} = scope, module) when is_atom(module),
    do: %__MODULE__{scope | uses: [module | scope.uses]}

  @doc "The import spec an `import` call's options describe."
  def import_spec(opts) do
    cond do
      Keyword.has_key?(opts, :only) -> spec(:only, Keyword.get(opts, :only))
      Keyword.has_key?(opts, :except) -> spec(:except, Keyword.get(opts, :except))
      true -> :all
    end
  end

  # `only: :functions | :macros | :sigils` admits everything for a name-level resolver.
  defp spec(kind, list) when is_list(list) do
    pairs = for {name, arity} <- list, is_atom(name) and is_integer(arity), do: {name, arity}
    {kind, pairs}
  end

  defp spec(_kind, _other), do: :all

  @doc "The imported modules that admit `name/arity`, most recent first."
  def import_candidates(%__MODULE__{} = scope, name, arity) do
    for {module, spec} <- scope.imports, admits?(spec, name, arity), do: module
  end

  @doc "Whether the implicit Kernel import still admits `name/arity`."
  def kernel_admits?(%__MODULE__{} = scope, name, arity), do: admits?(scope.kernel, name, arity)

  defp admits?(:all, _name, _arity), do: true
  defp admits?({:only, pairs}, name, arity), do: {name, arity} in pairs
  defp admits?({:except, pairs}, name, arity), do: {name, arity} not in pairs

  @doc """
  The scope after an `alias`/`import`/`require` form written in a body:
  `alias A.B`, `alias A.{B, C}`, `alias A, as: X`, `require A, as: X`,
  `import M, only: …`. A dynamic target changes nothing.
  """
  def apply_form(%__MODULE__{} = scope, form, [target_ast | rest]) when form in [:alias, :import, :require] do
    opts = rest |> Enum.filter(&Keyword.keyword?/1) |> List.flatten()

    Enum.reduce(resolve_targets(scope, target_ast), scope, fn
      nil, scope -> scope
      module, scope -> after_form(scope, form, module, opts)
    end)
  end

  def apply_form(%__MODULE__{} = scope, _form, _args), do: scope

  @doc "The modules an import form names: one, or each of `A.{B, C}`; nil for a dynamic one."
  def resolve_targets(%__MODULE__{} = scope, {{:., _, [base_ast, :{}]}, _, members}) do
    case resolve(scope, base_ast) do
      nil ->
        [nil]

      base ->
        Enum.map(members, fn
          {:__aliases__, _, parts} when is_list(parts) ->
            if Enum.all?(parts, &is_atom/1), do: Module.concat([base | parts]), else: nil

          _ ->
            nil
        end)
    end
  end

  def resolve_targets(%__MODULE__{} = scope, target_ast), do: [resolve(scope, target_ast)]

  # `alias` always aliases; `require` only with `as:`; `import` imports.
  defp after_form(scope, form, module, opts) when form in [:alias, :require] do
    case Keyword.get(opts, :as) do
      {:__aliases__, _, [as]} when is_atom(as) -> add_alias(scope, module, as)
      nil when form == :alias -> add_alias(scope, module, last_segment(module))
      _ -> scope
    end
  end

  defp after_form(scope, :import, module, opts), do: add_import(scope, module, import_spec(opts))

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
