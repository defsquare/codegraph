defmodule CodegraphElixir.Walker do
  @moduledoc """
  Passes 2 and 3 over ONE file's quoted AST: the entities the profile
  licenses (the file, every `defmodule`/`defprotocol`/`defimpl`, every
  `def`/`defp`/`defmacro`/`defmacrop`/`defguard`/`defdelegate` folded by
  name and arity) and the RAW edges — `import` for `alias`/`import`/
  `require`/`use`, `interfaceImplementation` for `@behaviour` and `defimpl`
  — whose targets are still module ATOMS. The extraction closes them against
  the corpus whitelist afterwards (§16.4): a walker sees one file and must
  not decide membership.
  """

  alias CodegraphElixir.Corpus.SourceFile
  alias CodegraphElixir.{Ids, Scope}
  alias CodegraphElixir.Model.{Entity, Key}

  defmodule Acc do
    @moduledoc false
    defstruct entities: [],
              edges: [],
              keys: MapSet.new(),
              modules: [],
              declared: [],
              duplicate_keys: [],
              dynamic_modules: 0,
              imports: %{alias: 0, import: 0, require: 0, use: 0}
  end

  @file_traits ["TNamed", "TModule", "TWithChildren", "TSourceAnchor"]
  @module_traits ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"]
  @function_traits [
    "TNamed",
    "TInvocable",
    "TWithChildren",
    "TWithParameters",
    "TWithInvocations",
    "TWithAccesses",
    "TChildOf",
    "TSourceAnchor"
  ]
  @callback_traits ["TNamed", "TInvocable", "TWithChildren", "TWithParameters", "TChildOf", "TSourceAnchor"]

  @definitions [:def, :defp, :defmacro, :defmacrop, :defguard, :defguardp, :defdelegate]
  @import_forms [:alias, :import, :require, :use]

  @doc "The file's entities, raw edges and counts. A file the parser rejected yields its file entity alone."
  def walk(%SourceFile{} = file) do
    file_key = Ids.file_key(file.rel)

    file_entity = %Entity{
      key: file_key,
      kind: "file",
      traits: @file_traits,
      name: file.rel,
      is_stub: false,
      defined_in: [file.rel],
      anchor: {file.rel, 1, file.lines}
    }

    acc = add_entity(%Acc{}, file_entity)

    if file.ast == nil do
      finish(acc)
    else
      ctx = %{file: file.rel, file_key: file_key, scope: Scope.new(), owner: file_key, kind: :file}
      {acc, _scope} = walk_forms(top_forms(file.ast), ctx, acc)
      finish(acc)
    end
  end

  defp finish(%Acc{} = acc) do
    %Acc{
      acc
      | entities: Enum.reverse(acc.entities),
        edges: Enum.reverse(acc.edges),
        modules: Enum.reverse(acc.modules),
        declared: Enum.reverse(acc.declared)
    }
  end

  # ------------------------------------------------------------------ forms --

  defp top_forms({:__block__, _, forms}), do: forms
  defp top_forms(form), do: [form]

  # Walk a body's forms in order, threading the lexical scope: an alias
  # written earlier applies to what follows, and nothing leaks out of a
  # nested module or a function body.
  defp walk_forms(forms, ctx, acc) do
    {acc, ctx} = Enum.reduce(forms, {acc, ctx}, fn form, {acc, ctx} -> walk_form(form, ctx, acc) end)
    {acc, ctx.scope}
  end

  defp walk_form({:defmodule, meta, [name_ast, opts]}, ctx, acc) do
    body = do_block(opts)

    case Scope.resolve(ctx.scope, name_ast) |> nest(ctx, name_ast) do
      nil ->
        {%Acc{acc | dynamic_modules: acc.dynamic_modules + 1}, ctx}

      module ->
        acc = define_module(module, "module", meta, body, ctx, acc, [])
        # Nesting aliases the first written segment inside the enclosing module.
        {acc, auto_alias(ctx, name_ast, module)}
    end
  end

  defp walk_form({:defprotocol, meta, [name_ast, opts]}, ctx, acc) do
    body = do_block(opts)

    case Scope.resolve(ctx.scope, name_ast) |> nest(ctx, name_ast) do
      nil ->
        {%Acc{acc | dynamic_modules: acc.dynamic_modules + 1}, ctx}

      module ->
        {define_module(module, "protocol", meta, body, ctx, acc, []), auto_alias(ctx, name_ast, module)}
    end
  end

  defp walk_form({:defimpl, meta, [proto_ast | rest]}, ctx, acc) do
    opts = List.flatten(Enum.filter(rest, &Keyword.keyword?/1))
    body = Keyword.get(opts, :do)

    targets =
      case Keyword.fetch(opts, :for) do
        {:ok, list} when is_list(list) -> list
        {:ok, single} -> [single]
        :error -> if ctx.kind == :module, do: [{:__MODULE__, [], nil}], else: []
      end

    protocol = Scope.resolve(ctx.scope, proto_ast)

    if protocol == nil or targets == [] do
      {%Acc{acc | dynamic_modules: acc.dynamic_modules + 1}, ctx}
    else
      acc =
        Enum.reduce(targets, acc, fn target_ast, acc ->
          case Scope.resolve(ctx.scope, target_ast) do
            nil ->
              %Acc{acc | dynamic_modules: acc.dynamic_modules + 1}

            target ->
              impl = Module.concat(protocol, target)
              # The block is the anchor of the edge target -> protocol.
              edge = %{
                kind: "interfaceImplementation",
                from: {:module, target},
                to: {:module, protocol},
                provenance: "declared",
                anchor: {ctx.file, line(meta), end_line({:defimpl, meta, [proto_ast | rest]})}
              }

              acc = %Acc{acc | edges: [edge | acc.edges]}
              define_module(impl, "module", meta, body, ctx, acc, attached_to: target, implements: true)
          end
        end)

      {acc, ctx}
    end
  end

  defp walk_form({definition, meta, args}, ctx, acc)
       when definition in @definitions and ctx.kind in [:module, :protocol] do
    acc = %Acc{acc | modules: record_clause(acc.modules, definition, meta, args, ctx)}
    {scoped_imports({definition, meta, args}, ctx, acc), ctx}
  end

  defp walk_form({:@, meta, [{attr, _, [target_ast]}]}, ctx, acc)
       when attr in [:behaviour, :behavior] and ctx.kind == :module do
    case Scope.resolve(ctx.scope, target_ast) do
      nil ->
        {%Acc{acc | dynamic_modules: acc.dynamic_modules + 1}, ctx}

      target ->
        edge = %{
          kind: "interfaceImplementation",
          from: ctx.owner,
          to: {:module, target},
          provenance: "declared",
          anchor: {ctx.file, line(meta), line(meta)}
        }

        {%Acc{acc | edges: [edge | acc.edges], modules: mark_implements(acc.modules)}, ctx}
    end
  end

  defp walk_form({form, meta, args}, ctx, acc) when form in @import_forms do
    import_form(form, meta, args, ctx, acc)
  end

  defp walk_form({:__block__, _, forms}, ctx, acc) do
    {acc, scope} = walk_forms(forms, ctx, acc)
    {acc, %{ctx | scope: scope}}
  end

  # A `quote` block's forms belong to whoever expands it, not to this module.
  defp walk_form({:quote, _, _}, ctx, acc), do: {acc, ctx}

  # Any other call with a `do` block at module level (`if Mix.env() == :test
  # do def … end`, a `for` over generated definitions) contains module forms.
  defp walk_form({_call, _meta, args} = form, ctx, acc) when is_list(args) do
    case blocks(args) do
      [] ->
        {scoped_imports(form, ctx, acc), ctx}

      bodies ->
        acc = Enum.reduce(bodies, acc, fn body, acc -> elem(walk_forms(top_forms(body), ctx, acc), 0) end)
        {acc, ctx}
    end
  end

  defp walk_form(_other, ctx, acc), do: {acc, ctx}

  # ---------------------------------------------------------------- modules --

  defp define_module(module, kind, meta, body, ctx, acc, opts) do
    key = Ids.module_key(ctx.file, module)
    span = {ctx.file, line(meta), Keyword.get(meta, :end, [])[:line] || line(meta)}
    attached_to = Keyword.get(opts, :attached_to)

    traits =
      @module_traits ++
        if(Keyword.get(opts, :implements, false), do: ["TWithImplements"], else: []) ++
        if(attached_to, do: ["TAttachedTo"], else: [])

    entity = %Entity{
      key: key,
      kind: kind,
      traits: traits,
      name: Scope.module_name(module),
      is_stub: false,
      parent: ctx.file_key,
      attached_to: attached_to && {:module, attached_to},
      anchor: span
    }

    {entity, acc} = add_entity_dedup(acc, entity, meta)
    inner_kind = if kind == "protocol", do: :protocol, else: :module

    inner_ctx = %{
      ctx
      | scope: Scope.enter_module(ctx.scope, module),
        owner: entity.key,
        kind: inner_kind
    }

    acc = %Acc{
      acc
      | modules: [%{key: entity.key, entity: entity, clauses: [], implements: false} | acc.modules],
        declared: [{module, entity.key, ctx.file_key} | acc.declared]
    }

    {acc, _scope} = walk_forms(top_forms(body), inner_ctx, acc)
    close_module(acc, ctx)
  end

  # The module's clause groups become function entities once its body is done.
  defp close_module(%Acc{modules: [current | rest]} = acc, ctx) do
    entity =
      if current.implements and "TWithImplements" not in current.entity.traits do
        %Entity{current.entity | traits: current.entity.traits ++ ["TWithImplements"]}
      else
        current.entity
      end

    acc = replace_entity(acc, entity)

    acc =
      current.clauses
      |> Enum.reverse()
      |> Enum.group_by(fn clause -> {clause.name, clause.arity} end)
      |> Enum.sort_by(fn {{name, arity}, _} -> {Key.utf16(Atom.to_string(name)), arity} end)
      |> Enum.reduce(acc, fn {{name, arity}, clauses}, acc ->
        first = List.first(clauses)
        defaults = Enum.max(Enum.map(clauses, & &1.defaults))
        start_line = clauses |> Enum.map(& &1.start) |> Enum.min()
        end_line = clauses |> Enum.map(& &1.end) |> Enum.max()

        {kind, traits} =
          case first.kind do
            :callback -> {"callback", @callback_traits}
            :macro -> {"macro", @function_traits}
            :function -> {"function", @function_traits}
          end

        extra =
          if(defaults > 0, do: [{"defaults", defaults}], else: []) ++
            if(first.private, do: [{"private", true}], else: [])

        entity = %Entity{
          key: Ids.function_key(entity.key, name, arity),
          kind: kind,
          traits: traits,
          name: Atom.to_string(name),
          signature: "#{name}/#{arity}",
          parent: entity.key,
          parameters: [],
          anchor: {ctx.file, start_line, end_line},
          extra: extra
        }

        {_, acc} = add_entity_dedup(acc, entity, line: start_line, column: 0)
        acc
      end)

    %Acc{acc | modules: rest}
  end

  defp mark_implements([current | rest]), do: [%{current | implements: true} | rest]
  defp mark_implements([]), do: []

  defp record_clause([current | rest], definition, meta, args, ctx) do
    case head_of(definition, args) do
      {:ok, name, arity, defaults} ->
        kind =
          cond do
            ctx.kind == :protocol -> :callback
            definition in [:defmacro, :defmacrop, :defguard, :defguardp] -> :macro
            true -> :function
          end

        clause = %{
          name: name,
          arity: arity,
          defaults: defaults,
          kind: kind,
          private: definition in [:defp, :defmacrop, :defguardp],
          start: line(meta),
          end: end_line({definition, meta, args})
        }

        [%{current | clauses: [clause | current.clauses]} | rest]

      :dynamic ->
        [current | rest]
    end
  end

  defp record_clause([], _definition, _meta, _args, _ctx), do: []

  # `def name(args)`, `def name(args) when guard`, `def name`; `defdelegate name(args), to: M`.
  defp head_of(_definition, [head | _]) do
    head =
      case head do
        {:when, _, [inner | _]} -> inner
        other -> other
      end

    case head do
      {name, _, args} when is_atom(name) and (is_list(args) or is_nil(args)) ->
        args = args || []
        {:ok, name, length(args), Enum.count(args, &match?({:\\, _, _}, &1))}

      _ ->
        :dynamic
    end
  end

  defp head_of(_definition, _), do: :dynamic

  # ---------------------------------------------------------------- imports --

  defp import_form(form, meta, [target_ast | rest], ctx, acc) do
    opts = List.flatten(Enum.filter(rest, &Keyword.keyword?/1))
    anchor = {ctx.file, line(meta), end_line({form, meta, [target_ast | rest]})}

    targets =
      case target_ast do
        # alias A.B.{C, D}
        {{:., _, [base_ast, :{}]}, _, members} ->
          case Scope.resolve(ctx.scope, base_ast) do
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

        other ->
          [Scope.resolve(ctx.scope, other)]
      end

    Enum.reduce(targets, {acc, ctx}, fn
      nil, {acc, ctx} ->
        {%Acc{acc | dynamic_modules: acc.dynamic_modules + 1}, ctx}

      module, {acc, ctx} ->
        edge = %{
          kind: "import",
          from: ctx.file_key,
          to: {:file_of, module},
          provenance: "declared",
          anchor: anchor,
          form: form
        }

        acc = %Acc{acc | edges: [edge | acc.edges], imports: Map.update!(acc.imports, form, &(&1 + 1))}
        {acc, %{ctx | scope: alias_from(ctx.scope, form, module, opts)}}
    end)
  end

  defp import_form(_form, _meta, _args, ctx, acc),
    do: {%Acc{acc | dynamic_modules: acc.dynamic_modules + 1}, ctx}

  # `alias` always aliases; `require` only with `as:`; `import`/`use` never.
  defp alias_from(scope, form, module, opts) when form in [:alias, :require] do
    case Keyword.get(opts, :as) do
      {:__aliases__, _, [as]} when is_atom(as) -> Scope.add_alias(scope, module, as)
      nil when form == :alias -> Scope.add_alias(scope, module, Scope.last_segment(module))
      _ -> scope
    end
  end

  defp alias_from(scope, _form, _module, _opts), do: scope

  # Inside a function body, a loop, a `case`: the import forms still count,
  # scoped to that body. `quote` blocks are skipped (their forms are the caller's).
  defp scoped_imports(form, ctx, acc) do
    {acc, _scope} = scan(form, ctx, acc)
    acc
  end

  defp scan({:quote, _, _}, ctx, acc), do: {acc, ctx.scope}

  defp scan({form, meta, args}, ctx, acc) when form in @import_forms and is_list(args) do
    {acc, ctx} = import_form(form, meta, args, ctx, acc)
    {acc, ctx.scope}
  end

  defp scan({_call, _meta, args}, ctx, acc) when is_list(args), do: scan_list(args, ctx, acc)
  defp scan({left, right}, ctx, acc), do: scan_list([left, right], ctx, acc)
  defp scan(list, ctx, acc) when is_list(list), do: scan_list(list, ctx, acc)
  defp scan(_leaf, ctx, acc), do: {acc, ctx.scope}

  defp scan_list(items, ctx, acc) do
    Enum.reduce(items, {acc, ctx.scope}, fn item, {acc, scope} -> scan(item, %{ctx | scope: scope}, acc) end)
  end

  # --------------------------------------------------------------- helpers --

  # `defmodule Bar` inside `Foo` defines `Foo.Bar`; an atom name is absolute.
  defp nest(nil, _ctx, _name_ast), do: nil

  defp nest(module, ctx, {:__aliases__, _, [first | _]}) when is_atom(first) and first != :"Elixir" do
    cond do
      ctx.scope.module == nil -> module
      Map.has_key?(ctx.scope.aliases, first) -> module
      true -> Module.concat(ctx.scope.module, module)
    end
  end

  defp nest(module, _ctx, _name_ast), do: module

  defp auto_alias(ctx, {:__aliases__, _, [first | _]}, module) when is_atom(first) and first != :"Elixir" do
    if ctx.scope.module == nil do
      ctx
    else
      alias_target =
        if first == Scope.last_segment(module), do: module, else: Module.concat(ctx.scope.module, first)

      %{ctx | scope: Scope.add_alias(ctx.scope, alias_target, first)}
    end
  end

  defp auto_alias(ctx, _name_ast, _module), do: ctx

  defp do_block(opts) when is_list(opts), do: Keyword.get(opts, :do)
  defp do_block(_), do: nil

  # Every `do:`/`else:`/… body among a call's keyword arguments.
  defp blocks(args) do
    args
    |> Enum.filter(&Keyword.keyword?/1)
    |> List.flatten()
    |> Enum.filter(fn {key, _} -> key in [:do, :else, :after, :rescue, :catch] end)
    |> Enum.map(&elem(&1, 1))
  end

  defp line(meta), do: Keyword.get(meta, :line, 1)

  # The last line any token of the node reaches: `end`, a closing paren, or
  # the end of the expression as the parser recorded it.
  defp end_line(ast) do
    {_, max} =
      Macro.prewalk(ast, 0, fn
        {_, meta, _} = node, max when is_list(meta) -> {node, max(max, meta_end(meta))}
        node, max -> {node, max}
      end)

    max
  end

  defp meta_end(meta) do
    [
      Keyword.get(meta, :line, 0),
      get_in(meta, [:end, :line]) || 0,
      get_in(meta, [:closing, :line]) || 0,
      get_in(meta, [:end_of_expression, :line]) || 0
    ]
    |> Enum.max()
  end

  defp add_entity(%Acc{} = acc, %Entity{} = entity) do
    %Acc{acc | entities: [entity | acc.entities], keys: MapSet.put(acc.keys, Key.index(entity.key))}
  end

  # Two declarations of one key in one file: the later carries its position
  # as the disambiguator, and the re-keying is named on stderr.
  defp add_entity_dedup(%Acc{} = acc, %Entity{} = entity, meta) do
    if MapSet.member?(acc.keys, Key.index(entity.key)) do
      tag = "#{Keyword.get(meta, :line, 0)}:#{Keyword.get(meta, :column, 0)}"
      rekeyed = %Entity{entity | key: Key.disambiguated(entity.key, tag)}
      note = "#{Key.render(entity.key)} -> #{Key.render(rekeyed.key)}"
      {rekeyed, add_entity(%Acc{acc | duplicate_keys: [note | acc.duplicate_keys]}, rekeyed)}
    else
      {entity, add_entity(acc, entity)}
    end
  end

  defp replace_entity(%Acc{} = acc, %Entity{} = entity) do
    at = Key.index(entity.key)
    %Acc{acc | entities: Enum.map(acc.entities, fn e -> if Key.index(e.key) == at, do: entity, else: e end)}
  end
end
