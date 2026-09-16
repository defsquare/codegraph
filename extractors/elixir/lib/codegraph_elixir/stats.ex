defmodule CodegraphElixir.Stats do
  @moduledoc """
  The stderr summary, in the other extractors' format. Every count here is a
  fact the model cannot carry: what was dropped and why, so the resolution
  ceiling of the baseline is stated rather than hidden (PLAN.md §16.5).

  `references` are the sites the walker read; `resolved` those that became
  an edge (to a corpus entity or to a stub — resolvability is not
  membership); `kernel` those that bound to the language itself (never an
  edge); everything else is dropped under its reason.
  """

  defstruct files_ex: 0,
            files_exs: 0,
            unparsed: [],
            modules: 0,
            imports: %{alias: 0, import: 0, require: 0, use: 0},
            imports_unresolved: 0,
            references: 0,
            resolved: 0,
            external: 0,
            kernel: 0,
            emitted: %{},
            dropped: %{},
            self_edges_dropped: 0,
            dynamic_modules_dropped: 0,
            duplicate_keys: [],
            duplicate_modules: [],
            unclosable: [],
            stubs: %{otp: 0, deps: 0}

  def drop(%__MODULE__{} = s, reason),
    do: %__MODULE__{s | dropped: Map.update(s.dropped, reason, 1, &(&1 + 1))}

  def drop(%__MODULE__{} = s, reason, n),
    do: %__MODULE__{s | dropped: Map.update(s.dropped, reason, n, &(&1 + n))}

  def summary(%__MODULE__{} = s, model) do
    stubs = s.stubs.otp + s.stubs.deps
    attempted = s.references
    rate = if attempted == 0, do: 100.0, else: 100.0 * (s.resolved + s.kernel) / attempted
    imports = s.imports.alias + s.imports.import + s.imports.require + s.imports.use
    dropped_total = s.dropped |> Map.values() |> Enum.sum()

    dropped =
      s.dropped
      |> Enum.sort_by(fn {reason, _} -> Atom.to_string(reason) end)
      |> Enum.map_join(", ", fn {reason, n} -> "#{reason} #{n}" end)

    emitted =
      s.emitted
      |> Enum.sort_by(fn {kind, _} -> kind end)
      |> Enum.map_join(", ", fn {kind, n} -> "#{kind} #{n}" end)

    """
    RESOLUTION SUMMARY
      references      : #{attempted}
      resolved        : #{s.resolved} (external: #{s.external}) + kernel: #{s.kernel} (the language, never an edge)
      dropped         : #{dropped_total}#{if dropped == "", do: "", else: " (" <> dropped <> ")"}
      resolution rate : #{:erlang.float_to_binary(rate, decimals: 1)}%
      imports         : #{imports} (alias #{s.imports.alias}, import #{s.imports.import}, require #{s.imports.require}, use #{s.imports.use}; external: #{s.imports_unresolved})
      files           : #{s.files_ex + s.files_exs} (.ex #{s.files_ex}, .exs #{s.files_exs}; unparsed: #{length(s.unparsed)})
      entities        : #{length(model.entities)} (stubs: #{stubs} — <otp> #{s.stubs.otp}, <deps> #{s.stubs.deps})
      edges           : #{length(model.edges)}#{if emitted == "", do: "", else: " (" <> emitted <> ")"}; self-edges dropped: #{s.self_edges_dropped}, dynamic module names dropped: #{s.dynamic_modules_dropped}
      duplicates      : #{length(s.duplicate_keys)} same-keyed declarations re-keyed, #{length(s.duplicate_modules)} module names declared in more than one file (the first in file order is the import target)
      unclosable      : #{length(s.unclosable)} edges dropped (an endpoint no entity declares)
    """
  end
end
