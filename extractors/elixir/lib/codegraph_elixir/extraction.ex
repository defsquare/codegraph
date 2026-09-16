defmodule CodegraphElixir.Extraction do
  @moduledoc """
  The passes, each a phase on stderr: walk + parse, per-file entities and raw
  edges, the whitelist, closing every raw target against it (§16.4), stubs,
  and the unclosable net (schemas/README.md §5) — an edge the model cannot
  close is dropped and counted, never written dangling and never an abort.
  """

  alias CodegraphElixir.{Corpus, Ids, Otp, Progress, Scope, Stats, Walker}
  alias CodegraphElixir.Model
  alias CodegraphElixir.Model.{Edge, Entity, Key}

  @extractor_name "codegraph-elixir"

  def extractor_name, do: @extractor_name

  def run(options, progress, version, cwd) do
    corpus =
      Progress.phase(progress, "parse", fn -> Corpus.load(options.sources, cwd) end, fn c ->
        "#{length(c.files)} files, #{Enum.count(c.files, &(&1.error != nil))} unparsed"
      end)

    walked =
      Progress.phase(
        progress,
        "entities",
        fn -> Enum.map(corpus.files, &Walker.walk/1) end,
        &"#{Enum.sum(Enum.map(&1, fn w -> length(w.entities) end))} entities"
      )

    entities = Enum.flat_map(walked, & &1.entities)
    raw_edges = Enum.flat_map(walked, & &1.edges)

    stats = %Stats{
      files_ex: Enum.count(corpus.files, &String.ends_with?(&1.rel, ".ex")),
      files_exs: Enum.count(corpus.files, &String.ends_with?(&1.rel, ".exs")),
      unparsed: corpus.files |> Enum.filter(&(&1.error != nil)) |> Enum.map(&"#{&1.rel}: #{&1.error}"),
      modules: Enum.count(entities, &(&1.kind in ["module", "protocol"])),
      imports:
        Enum.reduce(walked, %{alias: 0, import: 0, require: 0, use: 0}, fn w, acc ->
          Map.merge(acc, w.imports, fn _, a, b -> a + b end)
        end),
      dynamic_modules_dropped: Enum.sum(Enum.map(walked, & &1.dynamic_modules)),
      duplicate_keys: Enum.flat_map(walked, & &1.duplicate_keys)
    }

    # The whitelist: every module the corpus declares, by atom — the first
    # file in ordinal order owns the name when two files declare it.
    {whitelist, duplicates} =
      Progress.phase(progress, "whitelist", fn -> whitelist(Enum.flat_map(walked, & &1.declared)) end, fn {w,
                                                                                                           _} ->
        "#{map_size(w)} modules"
      end)

    stats = %Stats{stats | duplicate_modules: duplicates}

    {edges, entities, stubs, stats} =
      Progress.phase(progress, "edges", fn -> close(raw_edges, entities, whitelist, stats) end, fn {e, _, _,
                                                                                                    _} ->
        "#{length(e)} edges"
      end)

    stub_entities = Progress.phase(progress, "stubs", fn -> emit_stubs(stubs) end, &"#{length(&1)} stubs")

    stats = %Stats{
      stats
      | stubs: %{
          otp: Enum.count(stub_entities, &(&1.key.module == Ids.otp_module() and &1.kind == "module")),
          deps: Enum.count(stub_entities, &(&1.key.module == Ids.deps_module() and &1.kind == "module"))
        }
    }

    entities = entities ++ stub_entities
    declared = MapSet.new(entities, &Key.index(&1.key))

    {closed, unclosable} =
      Enum.split_with(edges, fn edge ->
        MapSet.member?(declared, Key.index(edge.from)) and MapSet.member?(declared, Key.index(edge.to))
      end)

    stats = %Stats{
      stats
      | unclosable: Enum.map(unclosable, &"#{&1.kind} #{Key.render(&1.from)} -> #{Key.render(&1.to)}")
    }

    model = %Model{
      lang: Key.lang(),
      extractor: [
        {"name", @extractor_name},
        {"version", version},
        {"elixir", Otp.elixir_version()},
        {"otp", Otp.otp_release()}
      ],
      root: corpus.root_display,
      repository: options.repository,
      entities: entities,
      edges: closed
    }

    %{model: model, stats: stats, corpus: corpus}
  end

  defp whitelist(declared) do
    declared
    |> Enum.reduce({%{}, []}, fn {atom, key, file_key}, {map, dups} ->
      case Map.fetch(map, atom) do
        {:ok, _} -> {map, [Scope.module_name(atom) | dups]}
        :error -> {Map.put(map, atom, %{key: key, parent: file_key}), dups}
      end
    end)
    |> then(fn {map, dups} -> {map, dups |> Enum.reverse() |> Enum.uniq()} end)
  end

  # Close raw targets: a corpus atom → its declared key, else a stub below the
  # reserved module the OTP table decides. Self-edges are dropped and counted.
  defp close(raw_edges, entities, whitelist, stats) do
    {edges, stubs, stats} =
      Enum.reduce(raw_edges, {[], MapSet.new(), stats}, fn raw, {edges, stubs, stats} ->
        {from, stubs} = resolve_end(raw.from, whitelist, stubs)
        {to, stubs} = resolve_end(raw.to, whitelist, stubs)

        stats =
          case raw.kind do
            "import" ->
              if(corpus_target?(raw.to, whitelist),
                do: stats,
                else: %Stats{stats | imports_unresolved: stats.imports_unresolved + 1}
              )

            _ ->
              stats
          end

        stats = %Stats{stats | references: stats.references + 1}

        stats =
          if corpus_target?(raw.to, whitelist),
            do: stats,
            else: %Stats{stats | unresolved: stats.unresolved + 1}

        if Key.index(from) == Key.index(to) do
          {edges, stubs, %Stats{stats | self_edges_dropped: stats.self_edges_dropped + 1}}
        else
          edge = %Edge{kind: raw.kind, from: from, to: to, provenance: raw.provenance, anchor: raw.anchor}
          {[edge | edges], stubs, stats}
        end
      end)

    {entities, stubs} =
      Enum.map_reduce(entities, stubs, fn
        %Entity{attached_to: {:module, atom}} = entity, stubs ->
          {key, stubs} = resolve_end({:module, atom}, whitelist, stubs)
          {%Entity{entity | attached_to: key}, stubs}

        entity, stubs ->
          {entity, stubs}
      end)

    {Enum.reverse(edges), entities, stubs, stats}
  end

  defp corpus_target?({:file_of, atom}, whitelist), do: Map.has_key?(whitelist, atom)
  defp corpus_target?({:module, atom}, whitelist), do: Map.has_key?(whitelist, atom)
  defp corpus_target?(%Key{}, _whitelist), do: true

  defp resolve_end(%Key{} = key, _whitelist, stubs), do: {key, stubs}

  defp resolve_end({:file_of, atom}, whitelist, stubs) do
    case Map.fetch(whitelist, atom) do
      {:ok, entity} -> {entity.parent, stubs}
      :error -> stub(atom, stubs)
    end
  end

  defp resolve_end({:module, atom}, whitelist, stubs) do
    case Map.fetch(whitelist, atom) do
      {:ok, entity} -> {entity.key, stubs}
      :error -> stub(atom, stubs)
    end
  end

  defp stub(atom, stubs) do
    origin = if Otp.module?(atom), do: :otp, else: :deps
    {Ids.stub_module_key(origin, atom), MapSet.put(stubs, {origin, atom})}
  end

  # Pass 4 — the stub discipline: a degraded `module` below its reserved
  # module, which exists only when something points below it.
  defp emit_stubs(stubs) do
    reserved =
      stubs
      |> Enum.map(fn {origin, _} -> origin end)
      |> Enum.uniq()
      |> Enum.map(fn origin ->
        key = Ids.reserved_key(origin)

        %Entity{
          key: key,
          kind: "file",
          traits: ["TNamed", "TModule", "TWithChildren"],
          name: key.module,
          is_stub: true,
          defined_in: []
        }
      end)

    modules =
      Enum.map(stubs, fn {origin, atom} ->
        %Entity{
          key: Ids.stub_module_key(origin, atom),
          kind: "module",
          traits: ["TNamed", "TType", "TChildOf"],
          name: Scope.module_name(atom),
          is_stub: true,
          parent: Ids.reserved_key(origin)
        }
      end)

    reserved ++ modules
  end
end
