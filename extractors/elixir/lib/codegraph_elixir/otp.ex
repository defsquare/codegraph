defmodule CodegraphElixir.Otp do
  @moduledoc """
  What the BEAM ships: every module of the building Erlang/OTP and Elixir
  installs, captured at COMPILE time into this module — the ct.sym of the
  Java image, the BCL reference pack of the C# binary. A module in this
  table is a stub below `<otp>`; one outside it, below `<deps>`. The
  versions ride in the header so a model says which table decided.
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

  @modules :code.all_available()
           |> Enum.filter(fn {_module, file, _loaded} -> shipped?.(file) end)
           |> Enum.map(fn {module, _, _} -> List.to_atom(module) end)
           # `Any` is the protocol fallback pseudo-type: defined by the
           # language, never a module on the code path.
           |> Enum.concat([Any])
           |> MapSet.new()

  @elixir_version System.version()
  @otp_release to_string(:erlang.system_info(:otp_release))

  def module?(module) when is_atom(module), do: MapSet.member?(@modules, module)

  def size, do: MapSet.size(@modules)

  def elixir_version, do: @elixir_version
  def otp_release, do: @otp_release
end
