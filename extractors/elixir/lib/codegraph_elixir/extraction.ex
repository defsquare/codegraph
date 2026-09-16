defmodule CodegraphElixir.Extraction do
  @moduledoc """
  The passes, each a phase on stderr: walk + parse, per-file entities and raw
  edges, the whitelist, closing every raw target against it (§16.4), stubs,
  and the unclosable net (schemas/README.md §5) — an edge the model cannot
  close is dropped and counted, never written dangling and never an abort.
  """

  alias CodegraphElixir.{Corpus, Deps, Ids, Otp, Progress, Scope, Stats, Trace, Walker}
  alias CodegraphElixir.Model
  alias CodegraphElixir.Model.{Edge, Entity, Key}

  @extractor_name "codegraph-elixir"

  def extractor_name, do: @extractor_name

  def run(options, progress, version, cwd) do
    corpus =
      Progress.phase(progress, "parse", fn -> Corpus.load(options.sources, cwd) end, fn c ->
        "#{length(c.files)} files, #{Enum.count(c.files, &(&1.error != nil))} unparsed"
      end)

    deps =
      Progress.phase(progress, "deps", fn -> Deps.load(options.deps, cwd) end, fn d ->
        "#{map_size(d)} modules' exports"
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
      duplicate_keys: Enum.flat_map(walked, & &1.duplicate_keys),
      dropped: Enum.reduce(walked, %{}, fn w, acc -> Map.merge(acc, w.counts, fn _, a, b -> a + b end) end),
      explained:
        if(options.explain_dropped,
          do: Enum.flat_map(walked, &Enum.reverse(&1.sites)) |> Enum.reverse(),
          else: []
        )
    }

    # The whitelist: every module the corpus declares, by atom — the first
    # file in ordinal order owns the name when two files declare it.
    {whitelist, duplicates} =
      Progress.phase(progress, "whitelist", fn -> whitelist(Enum.flat_map(walked, & &1.declared)) end, fn {w,
                                                                                                           _} ->
        "#{map_size(w)} modules"
      end)

    stats = %Stats{stats | duplicate_modules: duplicates}

    world = %{
      whitelist: whitelist,
      deps: deps,
      impls: impl_index(whitelist),
      explain?: options.explain_dropped
    }

    {edges, entities, stubs, stats} =
      Progress.phase(progress, "edges", fn -> close(raw_edges, entities, world, stats) end, fn {e, _, _, _} ->
        "#{length(e)} edges"
      end)

    # The `--trace` enrichment: what the compiler bound after expansion, as `generated` edges.
    {edges, stubs, stats} =
      Progress.phase(
        progress,
        "trace",
        fn -> Trace.merge(options.trace, corpus, world, edges, stubs, stats) end,
        fn {_, _, s} -> if(s.trace == nil, do: "none", else: "#{s.trace.added} edges added") end
      )

    stub_entities = Progress.phase(progress, "stubs", fn -> emit_stubs(stubs) end, &"#{length(&1)} stubs")

    stats = %Stats{
      stats
      | stubs: %{
          otp: Enum.count(stub_entities, &(&1.key.module == Ids.otp_module() and &1.kind == "module")),
          deps: Enum.count(stub_entities, &(&1.key.module == Ids.deps_module() and &1.kind == "module"))
        }
    }

    entities = mark_owners(entities, edges) ++ stub_entities
    declared = MapSet.new(entities, &Key.index(&1.key))

    {closed, unclosable} =
      Enum.split_with(edges, fn edge ->
        MapSet.member?(declared, Key.index(edge.from)) and MapSet.member?(declared, Key.index(edge.to)) and
          Enum.all?(edge.candidates || [], &MapSet.member?(declared, Key.index(&1)))
      end)

    stats = %Stats{
      stats
      | unclosable: Enum.map(unclosable, &"#{&1.kind} #{Key.render(&1.from)} -> #{Key.render(&1.to)}"),
        emitted: Enum.frequencies_by(closed, & &1.kind)
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
    |> Enum.reduce({%{}, []}, fn entry, {map, dups} ->
      case Map.fetch(map, entry.atom) do
        {:ok, _} -> {map, [Scope.module_name(entry.atom) | dups]}
        :error -> {Map.put(map, entry.atom, entry), dups}
      end
    end)
    |> then(fn {map, dups} -> {map, dups |> Enum.reverse() |> Enum.uniq()} end)
  end

  # protocol atom → every corpus `defimpl` of it.
  defp impl_index(whitelist) do
    whitelist
    |> Map.values()
    |> Enum.filter(&(&1.protocol != nil))
    |> Enum.group_by(& &1.protocol)
  end

  # ------------------------------------------------------------------ close --

  # Close raw targets against the whole corpus: a declared name → its key, a
  # shipped or foreign module → the stub module (the C# fold: a stub has no
  # members), a name that binds nowhere → dropped under its reason.
  defp close(raw_edges, entities, world, stats) do
    {edges, stubs, stats} =
      Enum.reduce(raw_edges, {[], MapSet.new(), stats}, fn raw, {edges, stubs, stats} ->
        stats = %Stats{stats | references: stats.references + 1}
        {from, stubs} = resolve_end(raw.from, world, stubs)

        case resolve_target(raw, world, stubs) do
          {:ok, to, candidates, stubs, external?} ->
            stats = %Stats{
              stats
              | resolved: stats.resolved + 1,
                external: stats.external + if(external?, do: 1, else: 0)
            }

            stats =
              if raw.kind == "import" and external?,
                do: %Stats{stats | imports_unresolved: stats.imports_unresolved + 1},
                else: stats

            if Key.index(from) == Key.index(to) do
              {edges, stubs, %Stats{stats | self_edges_dropped: stats.self_edges_dropped + 1}}
            else
              edge = %Edge{
                kind: raw.kind,
                from: from,
                to: to,
                # A candidate set is what makes a dispatch dynamic (METAMODEL.md §1.3).
                provenance: if(candidates == nil, do: raw.provenance, else: "dynamic-candidate"),
                anchor: raw.anchor,
                candidates: candidates,
                is_read: raw.is_read,
                is_write: raw.is_write
              }

              {[edge | edges], stubs, stats}
            end

          {:kernel, stubs} ->
            {edges, stubs, %Stats{stats | kernel: stats.kernel + 1}}

          {:drop, reason, stubs} ->
            stats = Stats.drop(stats, reason)
            stats = if world.explain?, do: Stats.explain(stats, reason, site(raw)), else: stats
            {edges, stubs, stats}
        end
      end)

    {entities, stubs} =
      Enum.map_reduce(entities, stubs, fn entity, stubs ->
        {attached, stubs} =
          case entity.attached_to do
            {:module, atom} -> resolve_end({:module, atom}, world, stubs)
            other -> {other, stubs}
          end

        {value, stubs} = close_value(entity.value, world, stubs)
        {%Entity{entity | attached_to: attached, value: value}, stubs}
      end)

    {Enum.reverse(edges), entities, stubs, stats}
  end

  # `reason file:line name` — what --explain-dropped prints.
  defp site(raw) do
    {file, line, _} = raw.anchor

    name =
      case raw.to do
        {:function, m, f, a} -> "#{Scope.module_name(m)}.#{f}/#{a}"
        {:local, _m, f, a, _} -> "#{f}/#{a}"
        {:handler, m, {f, a}} -> "#{Scope.module_name(m)}.#{f}/#{a}"
        {:attribute, m, n} -> "#{Scope.module_name(m)}.@#{n}"
        {:field, m, n} -> "%#{Scope.module_name(m)}{#{n}}"
        {:file_of, m} -> Scope.module_name(m)
        {:module, m} -> Scope.module_name(m)
        _ -> "?"
      end

    "#{file}:#{line} #{name}"
  end

  @doc "Resolve one raw edge's target against the corpus — shared with the trace merge."
  def resolve(raw, world, stubs), do: resolve_target(raw, world, stubs)

  @doc "Resolve an edge END (a key, or a module atom) — shared with the trace merge."
  def resolve_endpoint(target, world, stubs), do: resolve_end(target, world, stubs)

  @doc "The declared function of a corpus module covering `name/arity`, defaults folded."
  def declared_function(world, module, name, arity) do
    case Map.fetch(world.whitelist, module) do
      {:ok, declared} -> lookup(declared.functions, name, arity)
      :error -> nil
    end
  end

  # A `type` literal names a module: closed like any reference.
  defp close_value(nil, _world, stubs), do: {nil, stubs}

  defp close_value(%{k: "type", type: {:module, atom}} = literal, world, stubs) do
    {key, stubs} = resolve_end({:module, atom}, world, stubs)
    {%{literal | type: key}, stubs}
  end

  defp close_value(%{k: "array", items: items} = literal, world, stubs) do
    {items, stubs} = Enum.map_reduce(items, stubs, &close_value(&1, world, &2))
    {%{literal | items: items}, stubs}
  end

  defp close_value(literal, _world, stubs), do: {literal, stubs}

  defp resolve_target(raw, world, stubs) do
    case raw.to do
      {:function, module, name, arity} ->
        resolve_function(module, name, arity, raw, world, stubs)

      {:local, module, name, arity, snapshot} ->
        resolve_local(module, name, arity, snapshot, world, stubs)

      {:handler, module, {name, arity}} ->
        resolve_handler(module, name, arity, world, stubs)

      {:attribute, module, name} ->
        resolve_member(module, :attributes, name, :attribute_unbound, world, stubs)

      {:field, module, name} ->
        resolve_field(module, name, world, stubs)

      {:file_of, atom} ->
        resolve_import(atom, world, stubs)

      {:module, atom} ->
        ok(resolve_end({:module, atom}, world, stubs), world, atom)

      %Key{} = key ->
        {:ok, key, nil, stubs, false}
    end
  end

  defp ok({key, stubs}, world, atom), do: {:ok, key, nil, stubs, not Map.has_key?(world.whitelist, atom)}

  # An import of a NAMESPACE PREFIX no module declares (`alias Plausible.Stats.SQL`
  # then `SQL.Expression`) is not a dependency on anything: dropped and counted.
  defp resolve_import(atom, world, stubs) do
    cond do
      Map.has_key?(world.whitelist, atom) ->
        {:ok, Map.fetch!(world.whitelist, atom).file_key, nil, stubs, false}

      Otp.module?(atom) ->
        {key, stubs} = stub(atom, stubs)
        {:ok, key, nil, stubs, true}

      prefix?(atom, world) ->
        {:drop, :prefix_alias, stubs}

      true ->
        {key, stubs} = stub(atom, stubs)
        {:ok, key, nil, stubs, true}
    end
  end

  defp prefix?(atom, world) do
    prefix = Atom.to_string(atom) <> "."
    Enum.any?(world.whitelist, fn {declared, _} -> String.starts_with?(Atom.to_string(declared), prefix) end)
  end

  # `M.f(args)`: a declared function of a corpus module (a protocol's callback
  # dispatches to every corpus impl), else the stub module the OTP table or
  # the deps exports vouch for.
  defp resolve_function(module, _name, _arity, _raw, _world, stubs)
       when module in [Kernel, Kernel.SpecialForms],
       do: {:kernel, stubs}

  defp resolve_function(module, name, arity, raw, world, stubs) do
    case Map.fetch(world.whitelist, module) do
      {:ok, %{kind: :protocol} = declared} ->
        case lookup(declared.functions, name, arity) do
          nil ->
            {:drop, :remote_unbound, stubs}

          callback ->
            candidates =
              world.impls
              |> Map.get(module, [])
              |> Enum.map(&lookup(&1.functions, name, arity))
              |> Enum.reject(&is_nil/1)
              |> Enum.sort_by(&Key.sort_key/1)

            if raw.kind == "invocation",
              do: {:ok, callback, candidates, stubs, false},
              else: {:ok, callback, nil, stubs, false}
        end

      {:ok, declared} ->
        case lookup(declared.functions, name, arity) do
          nil -> {:drop, :remote_unbound, stubs}
          key -> {:ok, key, nil, stubs, false}
        end

      :error ->
        cond do
          Otp.module?(module) and Otp.exports?(module, name, arity) ->
            {key, stubs} = stub(module, stubs)
            {:ok, key, nil, stubs, true}

          Otp.module?(module) ->
            {:drop, :otp_unknown, stubs}

          Deps.exports?(world.deps, module, name, arity) or map_size(world.deps) == 0 ->
            {key, stubs} = stub(module, stubs)
            {:ok, key, nil, stubs, true}

          true ->
            {:drop, :deps_unknown, stubs}
        end
    end
  end

  # `f(args)`: the module's own definition, an explicit import that provides
  # it, Kernel, the sole foreign import that could, else nothing.
  defp resolve_local(module, name, arity, snapshot, world, stubs) do
    own =
      case module && Map.fetch(world.whitelist, module) do
        {:ok, declared} -> lookup(declared.functions, name, arity)
        _ -> nil
      end

    if own do
      {:ok, own, nil, stubs, false}
    else
      scope = %Scope{imports: snapshot.imports, kernel: snapshot.kernel}
      candidates = Scope.import_candidates(scope, name, arity)

      {found, unknown, stubs} =
        Enum.reduce_while(candidates, {nil, [], stubs}, fn candidate, {_, unknown, stubs} ->
          case Map.fetch(world.whitelist, candidate) do
            {:ok, declared} ->
              case lookup(declared.functions, name, arity, public: true) do
                nil -> {:cont, {nil, unknown, stubs}}
                key -> {:halt, {{key, false}, unknown, stubs}}
              end

            :error ->
              cond do
                Otp.module?(candidate) and Otp.exports?(candidate, name, arity) ->
                  {key, stubs} = stub(candidate, stubs)
                  {:halt, {{key, true}, unknown, stubs}}

                Otp.module?(candidate) ->
                  {:cont, {nil, unknown, stubs}}

                Deps.exports?(world.deps, candidate, name, arity) ->
                  {key, stubs} = stub(candidate, stubs)
                  {:halt, {{key, true}, unknown, stubs}}

                map_size(world.deps) == 0 ->
                  {:cont, {nil, [candidate | unknown], stubs}}

                true ->
                  {:cont, {nil, unknown, stubs}}
              end
          end
        end)

      cond do
        found != nil ->
          {key, external?} = found
          {:ok, key, nil, stubs, external?}

        Scope.kernel_admits?(scope, name, arity) and Otp.kernel?(name, arity) ->
          {:kernel, stubs}

        # The sole foreign import that could provide the name — unless a
        # `use` of a foreign module may have injected it, when nothing
        # honest can be said (the Ecto schema case).
        match?([_], unknown) and not injected?(snapshot, world) ->
          {key, stubs} = stub(hd(unknown), stubs)
          {:ok, key, nil, stubs, true}

        unknown != [] and injected?(snapshot, world) ->
          {:drop, :local_injected, stubs}

        unknown != [] ->
          {:drop, :ambiguous_import, stubs}

        injected?(snapshot, world) ->
          {:drop, :local_injected, stubs}

        true ->
          {:drop, :local_unbound, stubs}
      end
    end
  end

  # Any `use` may have injected the name — a corpus macro's `__using__` is as
  # opaque to the parser as a dependency's (the standard library's own tests
  # `use ExUnit.Case`).
  defp injected?(snapshot, _world), do: Map.get(snapshot, :uses, []) != []

  defp resolve_handler(module, name, arity, world, stubs) do
    case Map.fetch(world.whitelist, module) do
      {:ok, declared} ->
        case lookup(declared.functions, name, arity) do
          nil -> {:drop, :handler_unbound, stubs}
          key -> {:ok, key, [key], stubs, false}
        end

      :error ->
        {:drop, :handler_unbound, stubs}
    end
  end

  defp resolve_member(module, table, name, reason, world, stubs) do
    case Map.fetch(world.whitelist, module) do
      {:ok, declared} ->
        case Map.fetch(Map.fetch!(declared, table), name) do
          {:ok, key} -> {:ok, key, nil, stubs, false}
          :error -> {:drop, reason, stubs}
        end

      :error ->
        {:drop, reason, stubs}
    end
  end

  # A field of a stub module is nothing to point at: the struct reference already exists.
  defp resolve_field(module, name, world, stubs) do
    if Map.has_key?(world.whitelist, module),
      do: resolve_member(module, :fields, name, :field_unbound, world, stubs),
      else: {:drop, :field_external, stubs}
  end

  # Fold-aware: `f/1` written as `def f(a, b \\\\ 1)` is the `f#2` entity.
  defp lookup(functions, name, arity, opts \\ []) do
    public_only = Keyword.get(opts, :public, false)

    Enum.find_value(functions, fn {{n, a}, info} ->
      if n == name and arity <= a and arity >= a - info.defaults and not (public_only and info.private),
        do: info.key,
        else: nil
    end)
  end

  defp resolve_end(%Key{} = key, _world, stubs), do: {key, stubs}

  defp resolve_end({:module, atom}, world, stubs) do
    case Map.fetch(world.whitelist, atom) do
      {:ok, declared} -> {declared.key, stubs}
      :error -> stub(atom, stubs)
    end
  end

  defp stub(atom, stubs) do
    origin = if Otp.module?(atom), do: :otp, else: :deps
    {Ids.stub_module_key(origin, atom), MapSet.put(stubs, {origin, atom})}
  end

  # A file whose top level calls or reads is marked so — the marker traits are earned.
  defp mark_owners(entities, edges) do
    kinds_by_from =
      Enum.reduce(edges, %{}, fn edge, acc ->
        Map.update(acc, Key.index(edge.from), MapSet.new([edge.kind]), &MapSet.put(&1, edge.kind))
      end)

    Enum.map(entities, fn
      %Entity{kind: "file"} = entity ->
        kinds = Map.get(kinds_by_from, Key.index(entity.key), MapSet.new())

        traits =
          entity.traits
          |> add_if("TWithInvocations", MapSet.member?(kinds, "invocation"))
          |> add_if("TWithAccesses", MapSet.member?(kinds, "access"))

        %Entity{entity | traits: traits}

      entity ->
        entity
    end)
  end

  defp add_if(traits, trait, true), do: if(trait in traits, do: traits, else: traits ++ [trait])
  defp add_if(traits, _trait, false), do: traits

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
