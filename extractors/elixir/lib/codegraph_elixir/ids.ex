defmodule CodegraphElixir.Ids do
  @moduledoc """
  THE Elixir id scheme (PLAN.md §16.3). A natural key is
  `(module, symbol, disambiguator?)`:

      module (file)      lib%2Facme_order%2Forder.ex            root-relative path, escaped
      external           <otp> / Enum     <deps> / Ecto%2EChangeset   reserved modules, the atom as a name
      module (defmodule) …/Acme%2EOrder                          the atom, its dots escaped
      function / macro   …/Acme%2EOrder.total#1                  name, then ARITY — always present
      parameter          …/Acme%2EOrder.create#2#param:attrs

  Escaping, the one rule: `/`, `#`, `%` in every path segment and name, and
  `.` in NAMES, where it is the nesting separator — a module atom's own
  dots included. Injective by construction, reversible (`unescape/1`).
  """

  alias CodegraphElixir.Model.Key
  alias CodegraphElixir.Scope

  @otp "<otp>"
  @deps "<deps>"

  def otp_module, do: @otp
  def deps_module, do: @deps

  def escape_path(text) do
    text |> String.replace("%", "%25") |> String.replace("/", "%2F") |> String.replace("#", "%23")
  end

  def escape_name(text), do: text |> escape_path() |> String.replace(".", "%2E")

  def unescape(text) do
    Regex.replace(~r/%(25|2F|23|2E)/, text, fn
      _, "25" -> "%"
      _, "2F" -> "/"
      _, "23" -> "#"
      _, "2E" -> "."
    end)
  end

  @doc "The module of a corpus file: its root-relative path, escaped."
  def file_key(rel), do: Key.module(escape_path(rel))

  @doc "A `defmodule` below its file."
  def module_key(rel, module) when is_atom(module) do
    %Key{module: escape_path(rel), symbol: escape_name(Scope.module_name(module))}
  end

  @doc "A function, macro or callback below its module: name, then arity."
  def function_key(%Key{} = owner, name, arity) when is_atom(name) and is_integer(arity) do
    Key.disambiguated(Key.member(owner, escape_name(Atom.to_string(name))), Integer.to_string(arity))
  end

  @doc "The reserved stub module for an origin."
  def reserved_key(:otp), do: Key.module(@otp)
  def reserved_key(:deps), do: Key.module(@deps)

  @doc "An external module as a stub type below its reserved module."
  def stub_module_key(origin, module) when is_atom(module) do
    %Key{reserved_key(origin) | symbol: escape_name(Scope.module_name(module))}
  end
end
