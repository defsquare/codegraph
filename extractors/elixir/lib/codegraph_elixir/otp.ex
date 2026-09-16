defmodule CodegraphElixir.Otp do
  @moduledoc """
  What the BEAM ships: every module of the building Erlang/OTP and Elixir
  installs and what each exports, captured at COMPILE time into this module
  — the ct.sym of the Java image, the BCL reference pack of the C# binary.
  A module in this table is a stub below `<otp>`; one outside it, below
  `<deps>`; a local call that binds to a Kernel export is the language, not
  a dependency. The versions ride in the header so a model says which table
  decided.
  """

  otp_lib = to_string(:code.lib_dir())
  elixir_lib = :elixir |> :code.lib_dir() |> to_string() |> Path.dirname()

  shipped? = fn
    :preloaded ->
      true

    file when is_list(file) ->
      String.starts_with?(to_string(file), otp_lib) or String.starts_with?(to_string(file), elixir_lib)

    _ ->
      false
  end

  # `module_info(:exports)` lists macros as `MACRO-name` with one extra
  # argument (the caller's environment): restated as the name and arity a
  # call site writes.
  export_name = fn {name, arity} ->
    case Atom.to_string(name) do
      "MACRO-" <> macro -> {String.to_atom(macro), arity - 1}
      _ -> {name, arity}
    end
  end

  exports_of = fn module ->
    if Code.ensure_loaded?(module) do
      module.module_info(:exports)
      |> Enum.map(export_name)
      |> Enum.reject(fn {name, _} -> name in [:module_info, :__info__, :behaviour_info] end)
      |> MapSet.new()
    else
      MapSet.new()
    end
  end

  @exports :code.all_available()
           |> Enum.filter(fn {_module, file, _loaded} -> shipped?.(file) end)
           |> Enum.map(fn {module, _, _} -> List.to_atom(module) end)
           |> Map.new(fn module -> {module, exports_of.(module)} end)
           # The built-in protocol targets that are NOT modules on the code
           # path (`defimpl P, for: BitString`): defined by the language, like `Any`.
           |> Map.merge(Map.new([Any, BitString, Function, PID, Port, Reference, Tuple], &{&1, MapSet.new()}))

  @kernel MapSet.union(Map.fetch!(@exports, Kernel), Map.fetch!(@exports, Kernel.SpecialForms))

  @elixir_version System.version()
  @otp_release to_string(:erlang.system_info(:otp_release))

  def module?(module) when is_atom(module), do: Map.has_key?(@exports, module)

  @doc "Whether a shipped module exports `name/arity` (functions and macros alike)."
  def exports?(module, name, arity) when is_atom(module) and is_atom(name) do
    case Map.fetch(@exports, module) do
      {:ok, set} -> MapSet.member?(set, {name, arity})
      :error -> false
    end
  end

  @doc "A Kernel or Kernel.SpecialForms export: the language itself, never an edge."
  def kernel?(name, arity) when is_atom(name), do: MapSet.member?(@kernel, {name, arity})

  def size, do: map_size(@exports)

  def elixir_version, do: @elixir_version
  def otp_release, do: @otp_release
end
