defmodule CodegraphElixir.Model.Writer do
  @moduledoc """
  The JSONL writer (schemas/README.md): one record per line in canonical
  order, every reference a surrogate, every path interned, every closed
  vocabulary an index into the header's dictionaries. Written to match
  core's own encoder byte for byte — the second independent encoder, so the
  only thing to get right is the order of everything.
  """

  alias CodegraphElixir.Model
  alias CodegraphElixir.Model.{Edge, Entity, Json, Key}

  @schema_version "1.0.0"

  defmodule WriteError do
    defexception [:message]
  end

  @doc "Model → lines (iodata, no LF), canonical order. The caller adds the LF and decides where bytes go."
  def encode(%Model{} = model) do
    # 1. Canonical order is the surrogate assignment.
    entities = Enum.sort_by(model.entities, &Key.sort_key(&1.key))

    surrogate_of =
      entities
      |> Enum.with_index()
      |> Enum.reduce(%{}, fn {entity, index}, acc ->
        at = Key.index(entity.key)

        if Map.has_key?(acc, at) do
          raise WriteError, "duplicate natural key: #{Key.render(entity.key)}"
        end

        Map.put(acc, at, index)
      end)

    # 2. A module names itself: the entity with an empty, undisambiguated symbol.
    module_surrogate =
      entities
      |> Enum.with_index()
      |> Enum.reduce(%{}, fn {entity, index}, acc ->
        if Key.module?(entity.key), do: Map.put_new(acc, entity.key.module, index), else: acc
      end)

    ref_of = fn %Key{} = key, from ->
      case Map.fetch(surrogate_of, Key.index(key)) do
        {:ok, surrogate} ->
          surrogate

        :error ->
          raise WriteError, "#{from} references an entity this model does not declare: #{Key.render(key)}"
      end
    end

    # 3. The file table: every path any record can name, interned once, sorted.
    files =
      Enum.flat_map(entities, fn entity ->
        anchor = if entity.anchor, do: [elem(entity.anchor, 0)], else: []
        anchor ++ (entity.defined_in || [])
      end)
      |> Kernel.++(Enum.map(model.edges, &elem(&1.anchor, 0)))
      |> sorted_distinct()

    file_index = files |> Enum.with_index() |> Map.new()

    file_ref = fn path ->
      case Map.fetch(file_index, path) do
        {:ok, index} -> index
        :error -> raise WriteError, "unknown path: #{path}"
      end
    end

    wire_anchor = fn {file, start_line, end_line} -> [file_ref.(file), start_line, end_line] end

    # 4. Dictionaries: what this model actually uses, sorted.
    kinds = sorted_distinct(Enum.map(entities, & &1.kind))
    traits = sorted_distinct(Enum.flat_map(entities, & &1.traits))
    edge_kinds = sorted_distinct(Enum.map(model.edges, & &1.kind))
    provenances = sorted_distinct(Enum.map(model.edges, & &1.provenance))
    index_of = fn values -> values |> Enum.with_index() |> Map.new() end
    kind_ref = index_of.(kinds)
    trait_ref = index_of.(traits)
    edge_kind_ref = index_of.(edge_kinds)
    provenance_ref = index_of.(provenances)

    header =
      Json.object(
        [
          {"t", "header"},
          {"schemaVersion", @schema_version},
          {"lang", model.lang},
          {"extractor", {:object, model.extractor}},
          {"root", model.root}
        ] ++
          if(model.repository == nil, do: [], else: [{"repository", {:object, model.repository}}]) ++
          [
            {"dict",
             {:object,
              [{"kinds", kinds}, {"traits", traits}, {"edges", edge_kinds}, {"provenance", provenances}]}}
          ]
      )

    file_lines =
      files
      |> Enum.with_index()
      |> Enum.map(fn {path, index} -> Json.object([{"t", "f"}, {"i", index}, {"path", path}]) end)

    entity_lines =
      entities
      |> Enum.with_index()
      |> Enum.map(fn {%Entity{} = entity, index} ->
        module_index =
          case Map.fetch(module_surrogate, entity.key.module) do
            {:ok, at} ->
              at

            :error ->
              raise WriteError,
                    "entity #{Key.render(entity.key)} names module \"#{entity.key.module}\", which declares no module entity"
          end

        owner = Key.render(entity.key)

        head =
          [
            {"t", "e"},
            {"i", index},
            {"k", Map.fetch!(kind_ref, entity.kind)},
            {"tr", Enum.map(entity.traits, &Map.fetch!(trait_ref, &1))},
            {"m", module_index},
            # A module writes its own path in the symbol slot; everything else
            # its path below the module.
            {"s", if(index == module_index, do: entity.key.module, else: entity.key.symbol)}
          ] ++ if(entity.key.d == nil, do: [], else: [{"d", entity.key.d}])

        trait_keys =
          [
            {"name", entity.name},
            {"signature", entity.signature},
            {"isStub", entity.is_stub},
            {"parent", entity.parent && ref_of.(entity.parent, owner <> ".parent")},
            {"attachedTo", entity.attached_to && ref_of.(entity.attached_to, owner <> ".attachedTo")},
            {"parameters",
             entity.parameters && Enum.map(entity.parameters, &ref_of.(&1, owner <> ".parameters"))},
            {"definedIn", entity.defined_in && Enum.map(entity.defined_in, file_ref)},
            {"comments", entity.comments},
            {"metrics", entity.metrics && {:object, sort_pairs(entity.metrics)}},
            {"anchor", entity.anchor && wire_anchor.(entity.anchor)}
          ]
          |> Enum.reject(fn {_, value} -> value == nil end)

        # Keys no trait contributes ride through, sorted after the trait keys.
        extras = sort_pairs(entity.extra)
        Json.object(head ++ trait_keys ++ extras)
      end)

    edges =
      model.edges
      |> Enum.map(fn %Edge{} = edge ->
        {edge, ref_of.(edge.from, "edge #{edge.kind}"), ref_of.(edge.to, "edge #{edge.kind}")}
      end)
      |> Enum.sort_by(fn {edge, f, o} ->
        {file, start_line, end_line} = edge.anchor
        {f, o, Key.utf16(edge.kind), file_ref.(file), start_line, end_line, Key.utf16(edge.provenance)}
      end)

    edge_lines =
      Enum.map(edges, fn {edge, f, o} ->
        Json.object(
          [
            {"t", "x"},
            {"k", Map.fetch!(edge_kind_ref, edge.kind)},
            {"f", f},
            {"o", o},
            {"p", Map.fetch!(provenance_ref, edge.provenance)}
          ] ++
            if(edge.candidates == nil,
              do: [],
              else: [{"candidates", Enum.map(edge.candidates, &ref_of.(&1, "edge candidates"))}]
            ) ++
            [{"anchor", wire_anchor.(edge.anchor)}]
        )
      end)

    eof =
      Json.object([
        {"t", "eof"},
        {"counts",
         {:object, [{"files", length(files)}, {"entities", length(entities)}, {"edges", length(edges)}]}}
      ])

    [header] ++ file_lines ++ entity_lines ++ edge_lines ++ [eof]
  end

  @doc "The whole file as one binary — LF-terminated lines."
  def encode_to_string(model) do
    model |> encode() |> Enum.map(&[&1, "\n"]) |> IO.iodata_to_binary()
  end

  defp sorted_distinct(values) do
    values |> Enum.uniq() |> Enum.sort_by(&Key.utf16/1)
  end

  defp sort_pairs(pairs) do
    Enum.sort_by(pairs, fn {key, _} -> Key.utf16(to_string(key)) end)
  end
end
