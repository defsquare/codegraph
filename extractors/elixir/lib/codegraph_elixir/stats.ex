defmodule CodegraphElixir.Stats do
  @moduledoc """
  The stderr summary, in the other extractors' format. Every count here is a
  fact the model cannot carry: what was dropped and why, so the resolution
  ceiling of the baseline is stated rather than hidden (PLAN.md §16.5).
  """

  defstruct files_ex: 0,
            files_exs: 0,
            unparsed: [],
            modules: 0,
            imports: %{alias: 0, import: 0, require: 0, use: 0},
            imports_unresolved: 0,
            references: 0,
            unresolved: 0,
            self_edges_dropped: 0,
            dynamic_modules_dropped: 0,
            duplicate_keys: [],
            duplicate_modules: [],
            unclosable: [],
            stubs: %{otp: 0, deps: 0}

  def summary(%__MODULE__{} = s, model) do
    stubs = s.stubs.otp + s.stubs.deps
    resolved = s.references - s.unresolved
    rate = if s.references == 0, do: 100.0, else: 100.0 * resolved / s.references
    imports = s.imports.alias + s.imports.import + s.imports.require + s.imports.use

    """
    RESOLUTION SUMMARY
      references      : #{s.references}
      resolved        : #{resolved}
      unresolved      : #{s.unresolved}
      resolution rate : #{:erlang.float_to_binary(rate, decimals: 1)}%
      imports         : #{imports} (alias #{s.imports.alias}, import #{s.imports.import}, require #{s.imports.require}, use #{s.imports.use}; unresolved: #{s.imports_unresolved})
      files           : #{s.files_ex + s.files_exs} (.ex #{s.files_ex}, .exs #{s.files_exs}; unparsed: #{length(s.unparsed)})
      entities        : #{length(model.entities)} (stubs: #{stubs} — <otp> #{s.stubs.otp}, <deps> #{s.stubs.deps})
      edges           : #{length(model.edges)} (self-edges dropped: #{s.self_edges_dropped}, dynamic module names dropped: #{s.dynamic_modules_dropped})
      duplicates      : #{length(s.duplicate_keys)} same-keyed declarations re-keyed, #{length(s.duplicate_modules)} module names declared in more than one file (the first in file order is the import target)
      unclosable      : #{length(s.unclosable)} edges dropped (an endpoint no entity declares)
    """
  end
end
