defmodule CodegraphElixir.Walker do
  @moduledoc """
  Passes 2 and 3 over ONE file's quoted AST: the entities the profile
  licenses (the file, every `defmodule`/`defprotocol`/`defimpl`, every
  `def`/`defp`/`defmacro`/`defmacrop`/`defguard`/`defdelegate` folded by
  name and arity with its parameters, `defstruct` fields, module attributes,
  `@callback`s) and the RAW edges — `import` for `alias`/`import`/
  `require`/`use`, `interfaceImplementation` for `@behaviour`, `defimpl` and
  `@derive`, and everything a body writes (`CodegraphElixir.Body`) — whose
  targets are still NAMES. The extraction closes them against the corpus
  whitelist afterwards (§16.4): a walker sees one file and must not decide
  membership.
  """

  alias CodegraphElixir.Corpus.SourceFile
  alias CodegraphElixir.{Body, Ids, Literals, Measures, Scope}
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
              imports: %{alias: 0, import: 0, require: 0, use: 0},
              counts: %{},
              sites: []
  end

  @file_traits ["TNamed", "TModule", "TWithChildren", "TSourceAnchor", "TMetrics"]
  @module_traits ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor", "TMetrics"]
  @function_traits [
    "TNamed",
    "TInvocable",
    "TWithChildren",
    "TWithParameters",
    "TWithInvocations",
    "TWithAccesses",
    "TChildOf",
    "TSourceAnchor",
    "TMetrics"
  ]
  @callback_traits ["TNamed", "TInvocable", "TWithChildren", "TWithParameters", "TChildOf", "TSourceAnchor"]
  @field_traits ["TNamed", "TStructural", "TChildOf", "TSourceAnchor"]
  @attribute_traits ["TNamed", "TStructural", "TChildOf", "TSourceAnchor"]
  @parameter_traits ["TStructural", "TChildOf", "TSourceAnchor"]

  @definitions [:def, :defp, :defmacro, :defmacrop, :defguard, :defguardp, :defdelegate]
  @import_forms [:alias, :import, :require, :use]

  # Module attributes the language reserves: metadata, never a constant.
  @reserved_attributes [
    :moduledoc,
    :doc,
    :typedoc,
    :behaviour,
    :behavior,
    :impl,
    :spec,
    :type,
    :typep,
    :opaque,
    :callback,
    :macrocallback,
    :optional_callbacks,
    :derive,
    :enforce_keys,
    :before_compile,
    :after_compile,
    :after_verify,
    :on_definition,
    :on_load,
    :external_resource,
    :compile,
    :deprecated,
    :dialyzer,
    :file,
    :vsn,
    :fallback_to_any,
    :protocol,
    :for
  ]

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
      metrics: [{"sloc", Measures.sloc(file.token_lines, {1, file.lines})}],
      anchor: {file.rel, 1, file.lines}
    }

    acc = add_entity(%Acc{}, file_entity)

    if file.ast == nil do
      finish(acc)
    else
      ctx = %{
        file: file.rel,
        file_key: file_key,
        token_lines: file.token_lines,
        comments: file.comments,
        scope: Scope.new(),
        owner: file_key,
        module: nil,
        kind: :file
      }

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
  defp top_forms(nil), do: []
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

    case ctx.scope |> Scope.resolve(name_ast) |> nest(ctx, name_ast) do
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

    case ctx.scope |> Scope.resolve(name_ast) |> nest(ctx, name_ast) do
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
              acc =
                raw_edge(acc, "interfaceImplementation", {:module, target}, {:module, protocol}, "declared", {
                  ctx.file,
                  line(meta),
                  end_line({:defimpl, meta, [proto_ast | rest]})
                })

              define_module(impl, "module", meta, body, ctx, acc,
                attached_to: target,
                implements: true,
                protocol: protocol
              )
          end
        end)

      {acc, ctx}
    end
  end

  defp walk_form({definition, meta, args}, ctx, acc)
       when definition in @definitions and ctx.kind in [:module, :protocol] do
    {record_clause(definition, meta, args, ctx, acc), ctx}
  end

  defp walk_form({:@, meta, [{attr, _, [value]}]}, ctx, acc) when ctx.kind in [:module, :protocol] do
    {attribute(attr, value, meta, ctx, acc), ctx}
  end

  defp walk_form({:defstruct, meta, [fields]}, ctx, acc) when ctx.kind == :module do
    {struct_fields(fields, meta, ctx, acc), ctx}
  end

  defp walk_form({:defexception, meta, [fields]}, ctx, acc) when ctx.kind == :module do
    {struct_fields(fields, meta, ctx, acc), ctx}
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

  # Any other form at module or file level is compile-time code: its calls
  # are edges from the module (or the file), and a `do` block it carries
  # (`if Mix.env() == :test do def … end`, `schema "x" do field … end`)
  # holds module forms.
  defp walk_form({_call, meta, args} = form, ctx, acc) when is_list(args) do
    {bodies, rest_args} = split_blocks(args)
    acc = body(form_without_blocks(form, rest_args), meta, ctx, acc)
    acc = Enum.reduce(bodies, acc, fn body, acc -> elem(walk_forms(top_forms(body), ctx, acc), 0) end)
    {acc, ctx}
  end

  defp walk_form(other, ctx, acc), do: {body(other, [], ctx, acc), ctx}

  # ---------------------------------------------------------------- bodies --

  # A body walked for the owner in scope: the file at file level, the module
  # at module level (its body is compile-time code).
  defp body(ast, _meta, ctx, acc) do
    Body.walk(ast, %{file: ctx.file, scope: ctx.scope, owner: ctx.owner, module: ctx.module}, acc)
  end

  defp form_without_blocks({call, meta, _args}, rest_args), do: {call, meta, rest_args}

  defp split_blocks(args) do
    {keywords, positional} = Enum.split_with(args, &Keyword.keyword?/1)
    flat = List.flatten(keywords)
    {blocks, others} = Enum.split_with(flat, fn {key, _} -> key in [:do, :else, :after, :rescue, :catch] end)
    {Enum.map(blocks, &elem(&1, 1)), positional ++ if(others == [], do: [], else: [others])}
  end

  # ---------------------------------------------------------------- modules --

  defp define_module(module, kind, meta, body, ctx, acc, opts) do
    key = Ids.module_key(ctx.file, module)
    end_line = Keyword.get(meta, :end, [])[:line] || line(meta)
    span = {ctx.file, line(meta), end_line}
    attached_to = Keyword.get(opts, :attached_to)

    block = comment_block(ctx, line(meta))

    traits =
      @module_traits ++
        if(Keyword.get(opts, :implements, false), do: ["TWithImplements"], else: []) ++
        if(attached_to, do: ["TAttachedTo"], else: []) ++
        if(block, do: ["TComment"], else: [])

    entity = %Entity{
      key: key,
      kind: kind,
      traits: traits,
      name: Scope.module_name(module),
      is_stub: false,
      parent: ctx.file_key,
      attached_to: attached_to && {:module, attached_to},
      metrics: [{"sloc", Measures.sloc(ctx.token_lines, {line(meta), end_line})}],
      comments: block && [block],
      anchor: span
    }

    {entity, acc} = add_entity_dedup(acc, entity, meta)
    inner_kind = if kind == "protocol", do: :protocol, else: :module

    inner_ctx = %{
      ctx
      | scope: Scope.enter_module(ctx.scope, module),
        owner: entity.key,
        module: module,
        kind: inner_kind
    }

    frame = %{
      atom: module,
      key: entity.key,
      entity: entity,
      kind: inner_kind,
      protocol: Keyword.get(opts, :protocol),
      clauses: [],
      callbacks: [],
      implements: false,
      attributes: %{},
      fields: %{},
      specs: %{},
      doc: nil
    }

    acc = %Acc{acc | modules: [frame | acc.modules]}
    {acc, _scope} = walk_forms(top_forms(body), inner_ctx, acc)
    close_module(acc, inner_ctx)
  end

  # The module's clause groups become function entities once its body is done.
  defp close_module(%Acc{modules: [frame | rest]} = acc, ctx) do
    module_key = frame.key

    {acc, functions} =
      frame.clauses
      |> Enum.reverse()
      |> Enum.group_by(fn clause -> {clause.name, clause.arity} end)
      |> Enum.sort_by(fn {{name, arity}, _} -> {Key.utf16(Atom.to_string(name)), arity} end)
      |> Enum.reduce({acc, %{}}, fn {{name, arity}, clauses}, {acc, functions} ->
        {acc, key} = function_entity(module_key, name, arity, clauses, frame, ctx, acc)
        first = List.first(clauses)
        defaults = Enum.max(Enum.map(clauses, & &1.defaults))
        {acc, Map.put(functions, {name, arity}, %{key: key, defaults: defaults, private: first.private})}
      end)

    {acc, functions} =
      frame.callbacks
      |> Enum.reverse()
      |> Enum.reduce({acc, functions}, fn callback, {acc, functions} ->
        if Map.has_key?(functions, {callback.name, callback.arity}) do
          {acc, functions}
        else
          {acc, key} = callback_entity(module_key, callback, ctx, acc)
          {acc, Map.put(functions, {callback.name, callback.arity}, %{key: key, defaults: 0, private: false})}
        end
      end)

    # A `@spec` naming no function of the module references from the module.
    acc =
      Enum.reduce(frame.specs, acc, fn {{name, arity}, refs}, acc ->
        if lookup(functions, name, arity) == nil,
          do:
            Enum.reduce(refs, acc, fn {module, line}, acc -> reference(acc, module_key, module, line, ctx) end),
          else: acc
      end)

    traits =
      frame.entity.traits
      |> maybe_add("TWithImplements", frame.implements)
      |> maybe_add("TWithInvocations", has_edge?(acc, module_key, "invocation"))
      |> maybe_add("TWithAccesses", has_edge?(acc, module_key, "access"))

    acc = replace_entity(acc, %Entity{frame.entity | traits: traits})

    declared = %{
      atom: frame.atom,
      key: module_key,
      file_key: ctx.file_key,
      kind: frame.kind,
      protocol: frame.protocol,
      functions: functions,
      attributes: frame.attributes,
      fields: frame.fields
    }

    %Acc{acc | modules: rest, declared: [declared | acc.declared]}
  end

  defp function_entity(module_key, name, arity, clauses, frame, ctx, acc) do
    first = List.first(clauses)
    defaults = Enum.max(Enum.map(clauses, & &1.defaults))
    start_line = clauses |> Enum.map(& &1.start) |> Enum.min()
    end_line = clauses |> Enum.map(& &1.end) |> Enum.max()
    key = Ids.function_key(module_key, name, arity)

    {kind, traits} =
      case first.kind do
        :callback -> {"callback", @callback_traits}
        :macro -> {"macro", @function_traits}
        :function -> {"function", @function_traits}
      end

    comments = Enum.reject([first.doc, comment_block(ctx, start_line)], &is_nil/1)

    cyclomatic = 1 + (length(clauses) - 1) + Enum.sum(Enum.map(clauses, &(&1.cyclomatic - 1)))

    metrics =
      if kind == "callback",
        do: nil,
        else: [{"sloc", Measures.sloc(ctx.token_lines, {start_line, end_line})}, {"cyclomatic", cyclomatic}]

    extra =
      if(defaults > 0, do: [{"defaults", defaults}], else: []) ++
        if(first.private, do: [{"private", true}], else: [])

    # Parameters: one per position, named by the first clause that names it.
    # A name a head repeats (`def f(mode, mode)` pins the second) names one position only.
    {params, _seen} =
      Enum.map_reduce(0..(arity - 1)//1, MapSet.new(), fn index, seen ->
        named =
          Enum.find_value(clauses, fn clause -> Enum.at(clause.params, index) |> then(&(&1 && &1.name)) end)

        named = if named && MapSet.member?(seen, named), do: nil, else: named

        default =
          Enum.find_value(clauses, fn clause -> Enum.at(clause.params, index) |> then(&(&1 && &1.default)) end)

        tag = if named, do: "param:#{named}", else: "param:#{index + 1}"
        {{index, named, default, tag}, if(named, do: MapSet.put(seen, named), else: seen)}
      end)

    params =
      Enum.map(params, fn {_index, named, default, tag} ->
        {Key.disambiguated(key, tag), named, default}
      end)

    entity = %Entity{
      key: key,
      kind: kind,
      traits: traits |> maybe_add("TComment", comments != []) |> maybe_add("TWithValue", false),
      name: Atom.to_string(name),
      signature: "#{name}/#{arity}",
      parent: module_key,
      parameters: Enum.map(params, &elem(&1, 0)),
      comments: if(comments == [], do: nil, else: comments),
      metrics: metrics,
      anchor: {ctx.file, start_line, end_line},
      extra: extra
    }

    {entity, acc} = add_entity_dedup(acc, entity, line: start_line, column: 0)

    acc =
      Enum.reduce(params, acc, fn {param_key, named, default}, acc ->
        param_key = %Key{
          param_key
          | module: entity.key.module,
            symbol: entity.key.symbol,
            d: rebase(param_key.d, key, entity.key)
        }

        param = %Entity{
          key: param_key,
          kind: "parameter",
          traits:
            @parameter_traits |> maybe_add("TNamed", named != nil) |> maybe_add("TWithValue", default != nil),
          name: named && Atom.to_string(named),
          parent: entity.key,
          value: default,
          anchor: {ctx.file, first.start, first.start}
        }

        {_, acc} = add_entity_dedup(acc, param, line: first.start, column: 0)
        acc
      end)

    # The edges the clause bodies wrote for the planned key belong to the
    # entity that now owns it (re-keyed on a duplicate).
    acc = if entity.key == key, do: acc, else: rekey_edges(acc, key, entity.key)

    acc =
      Enum.reduce(
        Map.get(frame.specs, {name, arity}, []) ++ spec_refs_for(frame.specs, name, arity, defaults),
        acc,
        fn {module, line}, acc ->
          reference(acc, entity.key, module, line, ctx)
        end
      )

    {acc, entity.key}
  end

  # A parameter's disambiguator chains below the function's own when the function was re-keyed.
  defp rebase(d, planned, actual) do
    if planned == actual or actual.d == nil,
      do: d,
      else: actual.d <> "#" <> String.replace_prefix(d, (planned.d || "") <> "#", "")
  end

  defp callback_entity(module_key, callback, ctx, acc) do
    key = Ids.function_key(module_key, callback.name, callback.arity)

    entity = %Entity{
      key: key,
      kind: "callback",
      traits: @callback_traits,
      name: Atom.to_string(callback.name),
      signature: "#{callback.name}/#{callback.arity}",
      parent: module_key,
      parameters: [],
      anchor: {ctx.file, callback.line, callback.line}
    }

    {entity, acc} = add_entity_dedup(acc, entity, line: callback.line, column: 0)

    acc =
      Enum.reduce(callback.refs, acc, fn {module, line}, acc ->
        reference(acc, entity.key, module, line, ctx)
      end)

    {acc, entity.key}
  end

  # Specs written for a default-generated arity land on the folded entity.
  defp spec_refs_for(specs, name, arity, defaults) do
    for a <- (arity - defaults)..(arity - 1)//1, {m, l} <- Map.get(specs, {name, a}, []), do: {m, l}
  end

  defp lookup(functions, name, arity) do
    Enum.find_value(functions, fn {{n, a}, info} ->
      if n == name and arity <= a and arity >= a - info.defaults, do: info.key, else: nil
    end)
  end

  defp record_clause(definition, meta, args, ctx, %Acc{modules: [frame | rest]} = acc) do
    case head_of(args) do
      {:ok, name, params} ->
        arity = length(params)

        kind =
          cond do
            ctx.kind == :protocol -> :callback
            definition in [:defmacro, :defmacrop, :defguard, :defguardp] -> :macro
            true -> :function
          end

        key = Ids.function_key(frame.key, name, arity)
        body = definition_body(definition, args)

        clause = %{
          name: name,
          arity: arity,
          defaults: Enum.count(params, &(&1.default != nil)),
          # A default of `nil` or `false` is a default: presence is carried explicitly.
          params:
            Enum.map(params, fn param ->
              %{
                name: param.name,
                default: param.default && Literals.value_of(elem(param.default, 1), ctx.scope)
              }
            end),
          kind: kind,
          private: definition in [:defp, :defmacrop, :defguardp],
          start: line(meta),
          end: end_line({definition, meta, args}),
          doc: frame.doc,
          cyclomatic: if(body == nil, do: 1, else: Measures.cyclomatic(body))
        }

        frame = %{frame | clauses: [clause | frame.clauses], doc: nil}
        acc = %Acc{acc | modules: [frame | rest]}

        body_ctx = %{file: ctx.file, scope: ctx.scope, owner: key, module: ctx.module}

        acc =
          case definition do
            :defdelegate ->
              delegate(args, name, arity, key, meta, ctx, acc)

            _ ->
              # The parameter patterns read struct fields; the guard is code;
              # `do`, `rescue`, `catch`, `else` and `after` are all the body.
              acc = Body.walk(head_patterns(args), Map.put(body_ctx, :mode, :pattern), acc)
              acc = Body.walk(head_code(args), body_ctx, acc)
              Enum.reduce(definition_blocks(args), acc, fn block, acc -> Body.walk(block, body_ctx, acc) end)
          end

        # Import forms inside the body apply to it alone, and still count.
        scoped_imports({definition, meta, args}, ctx, acc)

      :dynamic ->
        %Acc{acc | counts: Map.update(acc.counts, :dynamic_definition, 1, &(&1 + 1))}
    end
  end

  defp record_clause(_definition, _meta, _args, _ctx, acc), do: acc

  # `defdelegate f(a), to: M, as: :g` — one written invocation, the delegation.
  defp delegate(args, name, arity, key, meta, ctx, acc) do
    opts = args |> Enum.filter(&Keyword.keyword?/1) |> List.flatten()

    with {:ok, target_ast} <- Keyword.fetch(opts, :to),
         module when module != nil <- Scope.resolve(ctx.scope, target_ast) do
      as = Keyword.get(opts, :as, name)
      as = if is_atom(as), do: as, else: name

      raw_edge(
        acc,
        "invocation",
        key,
        {:function, module, as, arity},
        "declared",
        {ctx.file, line(meta), line(meta)}
      )
    else
      _ -> %Acc{acc | counts: Map.update(acc.counts, :dynamic_dispatch, 1, &(&1 + 1))}
    end
  end

  # `def name(args)`, `def name(args) when guard`, `def name`.
  defp head_of([head | _]) do
    head =
      case head do
        {:when, _, [inner | _]} -> inner
        other -> other
      end

    case head do
      {name, _, args} when is_atom(name) and (is_list(args) or is_nil(args)) ->
        {:ok, name, Enum.map(args || [], &param_of/1)}

      _ ->
        :dynamic
    end
  end

  defp head_of(_), do: :dynamic

  # The name a position carries, and its `\\` default. `_`-prefixed names are none.
  defp param_of({:\\, _, [pattern, default]}), do: %{param_of(pattern) | default: {:some, default}}

  defp param_of({:=, _, [left, right]}),
    do: %{name: param_of(left).name || param_of(right).name, default: nil}

  defp param_of({name, _, ctx}) when is_atom(name) and is_atom(ctx) do
    text = Atom.to_string(name)
    %{name: if(String.starts_with?(text, "_"), do: nil, else: name), default: nil}
  end

  defp param_of(_), do: %{name: nil, default: nil}

  # The guard of a head is code; the parameter patterns are walked as patterns.
  defp head_code([{:when, _, [_head, guard]} | _]), do: guard
  defp head_code(_), do: nil

  defp head_patterns([{:when, _, [head | _]} | _]), do: head_patterns([head])
  defp head_patterns([{_name, _, args} | _]) when is_list(args), do: args
  defp head_patterns(_), do: []

  defp definition_blocks(args) do
    args
    |> Enum.filter(&Keyword.keyword?/1)
    |> List.flatten()
    |> Enum.filter(fn {key, _} -> key in [:do, :rescue, :catch, :else, :after] end)
    |> Enum.map(&elem(&1, 1))
  end

  defp definition_body(:defdelegate, _args), do: nil

  defp definition_body(_definition, args) do
    args
    |> Enum.filter(&Keyword.keyword?/1)
    |> List.flatten()
    |> Keyword.get(:do)
  end

  # ------------------------------------------------------------ attributes --

  defp attribute(:moduledoc, value, _meta, _ctx, %Acc{modules: [frame | rest]} = acc) do
    case doc_text(value) do
      nil -> acc
      text -> %Acc{acc | modules: [%{frame | entity: with_comment(frame.entity, text)} | rest]}
    end
  end

  defp attribute(:doc, value, _meta, _ctx, %Acc{modules: [frame | rest]} = acc) do
    %Acc{acc | modules: [%{frame | doc: doc_text(value)} | rest]}
  end

  defp attribute(attr, target_ast, meta, ctx, %Acc{modules: [frame | rest]} = acc)
       when attr in [:behaviour, :behavior] do
    case Scope.resolve(ctx.scope, target_ast) do
      nil ->
        %Acc{acc | dynamic_modules: acc.dynamic_modules + 1}

      target ->
        acc = %Acc{acc | modules: [%{frame | implements: true} | rest]}

        raw_edge(acc, "interfaceImplementation", ctx.owner, {:module, target}, "declared", {
          ctx.file,
          line(meta),
          line(meta)
        })
    end
  end

  # `@derive P`, `@derive {P, opts}`, `@derive [P, {Q, opts}]`: the language defines the expansion.
  defp attribute(:derive, value, meta, ctx, %Acc{modules: [frame | rest]} = acc) do
    targets =
      case value do
        list when is_list(list) -> list
        other -> [other]
      end
      |> Enum.map(fn
        {proto, _opts} -> proto
        {:{}, _, [proto | _]} -> proto
        proto -> proto
      end)

    acc = %Acc{acc | modules: [%{frame | implements: true} | rest]}

    Enum.reduce(targets, acc, fn target_ast, acc ->
      case Scope.resolve(ctx.scope, target_ast) do
        nil ->
          %Acc{acc | dynamic_modules: acc.dynamic_modules + 1}

        target ->
          raw_edge(acc, "interfaceImplementation", ctx.owner, {:module, target}, "generated", {
            ctx.file,
            line(meta),
            line(meta)
          })
      end
    end)
  end

  defp attribute(:spec, spec, meta, ctx, %Acc{modules: [frame | rest]} = acc) do
    case spec_head(spec) do
      {:ok, name, arity} ->
        refs = typespec_refs(spec, ctx, line(meta))
        specs = Map.update(frame.specs, {name, arity}, refs, &(&1 ++ refs))
        %Acc{acc | modules: [%{frame | specs: specs} | rest]}

      :dynamic ->
        acc
    end
  end

  defp attribute(attr, spec, meta, ctx, %Acc{modules: [frame | rest]} = acc)
       when attr in [:callback, :macrocallback] do
    case spec_head(spec) do
      {:ok, name, arity} ->
        callback = %{name: name, arity: arity, line: line(meta), refs: typespec_refs(spec, ctx, line(meta))}
        %Acc{acc | modules: [%{frame | callbacks: [callback | frame.callbacks]} | rest]}

      :dynamic ->
        acc
    end
  end

  # `@type t :: …`: not an entity in M15; its remote types are references from the module.
  defp attribute(attr, spec, meta, ctx, acc) when attr in [:type, :typep, :opaque] do
    Enum.reduce(typespec_refs(spec, ctx, line(meta)), acc, fn {module, line}, acc ->
      reference(acc, ctx.owner, module, line, ctx)
    end)
  end

  defp attribute(attr, _value, _meta, _ctx, acc) when attr in @reserved_attributes, do: acc

  # `@name value`: the module constant, its value's references and accesses its own.
  defp attribute(name, value, meta, ctx, %Acc{modules: [frame | rest]} = acc) do
    if Map.has_key?(frame.attributes, name) do
      %Acc{acc | counts: Map.update(acc.counts, :attribute_redefined, 1, &(&1 + 1))}
    else
      key = Key.member(frame.key, "@" <> Ids.escape_name(Atom.to_string(name)))
      literal = Literals.value_of(value, ctx.scope)

      entity = %Entity{
        key: key,
        kind: "attribute",
        traits: @attribute_traits |> maybe_add("TWithValue", literal != nil),
        name: "@" <> Atom.to_string(name),
        parent: frame.key,
        value: literal,
        anchor: {ctx.file, line(meta), end_line(value) |> max(line(meta))}
      }

      {entity, acc} = add_entity_dedup(acc, entity, meta)
      before = length(acc.edges)
      acc = Body.walk(value, %{file: ctx.file, scope: ctx.scope, owner: entity.key, module: ctx.module}, acc)
      written = Enum.take(acc.edges, length(acc.edges) - before)

      traits =
        entity.traits
        |> maybe_add("TWithInvocations", Enum.any?(written, &(&1.kind == "invocation")))
        |> maybe_add("TWithAccesses", Enum.any?(written, &(&1.kind == "access")))

      acc = replace_entity(acc, %Entity{entity | traits: traits})
      frame = %{frame | attributes: Map.put(frame.attributes, name, entity.key)}
      %Acc{acc | modules: [frame | rest]}
    end
  end

  defp doc_text(text) when is_binary(text), do: text
  defp doc_text({:<<>>, _, parts}), do: if(Enum.all?(parts, &is_binary/1), do: Enum.join(parts), else: nil)
  defp doc_text(_), do: nil

  defp with_comment(%Entity{} = entity, text) do
    %Entity{
      entity
      | traits: maybe_add(entity.traits, "TComment", true),
        comments: (entity.comments || []) ++ [text]
    }
  end

  # `name(args) :: ret`, `name(args) :: ret when …`
  defp spec_head({:when, _, [inner | _]}), do: spec_head(inner)
  defp spec_head({:"::", _, [{name, _, args}, _ret]}) when is_atom(name), do: {:ok, name, length(args || [])}
  defp spec_head(_), do: :dynamic

  # Every remote type `M.t()` a typespec names, with its line.
  defp typespec_refs(spec, ctx, line) do
    {_, refs} =
      Macro.prewalk(spec, [], fn
        {{:., _, [module_ast, _type]}, _, _} = node, refs ->
          case Scope.resolve(ctx.scope, module_ast) do
            nil -> {node, refs}
            module -> {node, [{module, line} | refs]}
          end

        node, refs ->
          {node, refs}
      end)

    Enum.reverse(refs)
  end

  defp reference(acc, from, module, line, ctx) do
    raw_edge(acc, "reference", from, {:module, module}, "declared", {ctx.file, line, line})
  end

  # ---------------------------------------------------------------- fields --

  # `defstruct [:a, b: 1]` / `defstruct a: 1` / `defexception [:message]`.
  defp struct_fields(fields, meta, ctx, %Acc{} = acc) when is_list(fields) do
    Enum.reduce(fields, acc, fn
      field, %Acc{modules: [frame | rest]} = acc when is_atom(field) ->
        add_field(field, :none, meta, ctx, frame, rest, acc)

      {field, default}, %Acc{modules: [frame | rest]} = acc when is_atom(field) ->
        add_field(field, {:some, default}, meta, ctx, frame, rest, acc)

      _other, acc ->
        %Acc{acc | counts: Map.update(acc.counts, :dynamic_field, 1, &(&1 + 1))}
    end)
  end

  defp struct_fields(_fields, _meta, _ctx, acc) do
    %Acc{acc | counts: Map.update(acc.counts, :dynamic_struct, 1, &(&1 + 1))}
  end

  defp add_field(field, default, meta, ctx, frame, rest, acc) do
    key = Key.member(frame.key, Ids.escape_name(Atom.to_string(field)))

    literal =
      case default do
        {:some, ast} -> Literals.value_of(ast, ctx.scope)
        :none -> nil
      end

    entity = %Entity{
      key: key,
      kind: "field",
      traits: @field_traits |> maybe_add("TWithValue", literal != nil),
      name: Atom.to_string(field),
      parent: frame.key,
      value: literal,
      anchor: {ctx.file, line(meta), line(meta)}
    }

    {entity, acc} = add_entity_dedup(acc, entity, meta)
    frame = %{frame | fields: Map.put(frame.fields, field, entity.key)}
    %Acc{acc | modules: [frame | rest]}
  end

  # ---------------------------------------------------------------- imports --

  defp import_form(form, meta, [target_ast | rest], ctx, acc) do
    opts = List.flatten(Enum.filter(rest, &Keyword.keyword?/1))
    anchor = {ctx.file, line(meta), end_line({form, meta, [target_ast | rest]})}

    targets = Scope.resolve_targets(ctx.scope, target_ast)

    Enum.reduce(targets, {acc, ctx}, fn
      nil, {acc, ctx} ->
        {%Acc{acc | dynamic_modules: acc.dynamic_modules + 1}, ctx}

      module, {acc, ctx} ->
        acc = raw_edge(acc, "import", ctx.file_key, {:file_of, module}, "declared", anchor)
        acc = %Acc{acc | imports: Map.update!(acc.imports, form, &(&1 + 1))}

        # `use X` is `require X` + `X.__using__(opts)`: a written invocation.
        acc =
          if form == :use and ctx.kind in [:module, :protocol],
            do:
              raw_edge(acc, "invocation", ctx.owner, {:function, module, :__using__, 1}, "declared", anchor),
            else: acc

        {acc, %{ctx | scope: scope_after(ctx.scope, form, module, opts)}}
    end)
  end

  defp import_form(_form, _meta, _args, ctx, acc),
    do: {%Acc{acc | dynamic_modules: acc.dynamic_modules + 1}, ctx}

  # `alias` always aliases; `require` only with `as:`; `import` imports; `use` nothing.
  defp scope_after(scope, form, module, opts) when form in [:alias, :require] do
    case Keyword.get(opts, :as) do
      {:__aliases__, _, [as]} when is_atom(as) -> Scope.add_alias(scope, module, as)
      nil when form == :alias -> Scope.add_alias(scope, module, Scope.last_segment(module))
      _ -> scope
    end
  end

  defp scope_after(scope, :import, module, opts), do: Scope.add_import(scope, module, Scope.import_spec(opts))
  defp scope_after(scope, :use, module, _opts), do: Scope.add_use(scope, module)
  defp scope_after(scope, _form, _module, _opts), do: scope

  # Inside a function body, a loop, a `case`: the import forms still count,
  # scoped to that body. `quote` blocks are skipped (their forms are the caller's).
  defp scoped_imports(form, ctx, acc) do
    {acc, _scope} = scan(form, ctx, acc)
    acc
  end

  defp scan({:quote, _, _}, ctx, acc), do: {acc, ctx.scope}

  defp scan({form, meta, args}, ctx, acc) when form in @import_forms and is_list(args) do
    {acc, ctx} = import_form(form, meta, args, %{ctx | kind: :body}, acc)
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

  # The `#` comment block written directly above a line, as one text.
  defp comment_block(ctx, start_line) do
    lines = Stream.iterate(start_line - 1, &(&1 - 1)) |> Enum.take_while(&Map.has_key?(ctx.comments, &1))

    case lines do
      [] ->
        nil

      _ ->
        lines |> Enum.reverse() |> Enum.map_join("\n", fn l -> ctx.comments |> Map.fetch!(l) |> elem(1) end)
    end
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

  defp maybe_add(traits, trait, true), do: if(trait in traits, do: traits, else: traits ++ [trait])
  defp maybe_add(traits, _trait, false), do: traits

  defp has_edge?(%Acc{edges: edges}, from, kind), do: Enum.any?(edges, &(&1.from == from and &1.kind == kind))

  defp raw_edge(%Acc{} = acc, kind, from, to, provenance, anchor) do
    edge = %{
      kind: kind,
      from: from,
      to: to,
      provenance: provenance,
      anchor: anchor,
      is_read: nil,
      is_write: nil
    }

    %Acc{acc | edges: [edge | acc.edges]}
  end

  defp rekey_edges(%Acc{} = acc, planned, actual) do
    %Acc{acc | edges: Enum.map(acc.edges, fn e -> if e.from == planned, do: %{e | from: actual}, else: e end)}
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
