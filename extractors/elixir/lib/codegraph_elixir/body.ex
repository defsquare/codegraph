defmodule CodegraphElixir.Body do
  @moduledoc """
  Pass 3 over one BODY — a function clause, a module attribute's value, a
  script's top level: the raw edges it writes. A remote call `M.f(…)`, a
  local call `f(…)`, a capture `&M.f/2`, a struct `%M{k: …}`, an attribute
  read `@x`, a `raise M`, a module used as a value — each becomes a raw edge
  whose target is still a NAME (`{:function, M, :f, 2}`, `{:local, …}`);
  the extraction closes them against the whole corpus (§16.4), because one
  body cannot know what a module declares or what `<otp>` exports.

  Modes: `:expr` (a construction writes struct fields), `:pattern` (a match
  reads them), `:capture` (a call inside `&…` is a reference, the call
  happens elsewhere). `quote` blocks are skipped: their forms are the caller's.
  """

  alias CodegraphElixir.Scope

  # Forms that are syntax, never a call to resolve.
  @syntax [
    :__block__,
    :__aliases__,
    :__MODULE__,
    :__ENV__,
    :__DIR__,
    :__CALLER__,
    :__STACKTRACE__,
    :=,
    :^,
    :&,
    :fn,
    :->,
    :<-,
    :when,
    :\\,
    :|,
    :"::",
    :{},
    :%{},
    :%,
    :<<>>,
    :.,
    :quote,
    :unquote,
    :unquote_splicing,
    :alias,
    :import,
    :require,
    :use,
    :super
  ]

  @doc """
  Walk a body. `ctx`: `file`, `scope`, `owner` (the key edges start from),
  `module` (the enclosing module atom or nil), `mode`. `acc` must carry
  `edges` (raw, prepended) and `counts` (a map of dropped sites by reason).
  """
  def walk(ast, ctx, acc) do
    ast |> unpipe() |> visit(Map.put_new(ctx, :mode, :expr), acc)
  end

  # `x |> f(a)` is `f(x, a)`: the arity a call site means.
  defp unpipe(ast) do
    Macro.prewalk(ast, fn
      {:|>, _, [left, {call, meta, args}]} when is_list(args) -> {call, meta, [left | args]}
      {:|>, _, [left, {call, meta, nil}]} -> {call, meta, [left]}
      other -> other
    end)
  end

  # ------------------------------------------------------------ visiting --

  # A block's forms in order: an `alias` written earlier applies to what follows.
  defp visit({:__block__, _, forms}, ctx, acc) do
    {acc, _ctx} =
      Enum.reduce(forms, {acc, ctx}, fn
        {form, _, args}, {acc, ctx} when form in [:alias, :import, :require] and is_list(args) ->
          {acc, %{ctx | scope: Scope.apply_form(ctx.scope, form, args)}}

        form, {acc, ctx} ->
          {visit(form, ctx, acc), ctx}
      end)

    acc
  end

  defp visit({:quote, _, _}, _ctx, acc), do: acc

  # `@x` in a body: a read of the module's attribute.
  defp visit({:@, meta, [{name, _, atom}]}, ctx, acc) when is_atom(name) and is_atom(atom) do
    if ctx.module do
      raw(acc, "access", ctx.owner, {:attribute, ctx.module, name}, meta, ctx, is_read: true, is_write: false)
    else
      acc
    end
  end

  # `%M{…}`: a reference to M, then its fields (read in a pattern, written otherwise).
  defp visit({:%, meta, [module_ast, {:%{}, _, pairs}]}, ctx, acc) do
    case Scope.resolve(ctx.scope, module_ast) do
      nil ->
        visit_all(pairs, ctx, count(acc, :dynamic_module, meta, ctx, module_ast))

      module ->
        acc = raw(acc, "reference", ctx.owner, {:module, module}, meta, ctx)

        {pairs, acc} =
          case pairs do
            [{:|, _, [base, updates]}] -> {updates, visit(base, %{ctx | mode: :expr}, acc)}
            _ -> {pairs, acc}
          end

        Enum.reduce(pairs, acc, fn
          {key, value}, acc when is_atom(key) ->
            flag =
              if ctx.mode == :pattern,
                do: [is_read: true, is_write: false],
                else: [is_read: false, is_write: true]

            acc = raw(acc, "access", ctx.owner, {:field, module, key}, meta, ctx, flag)
            visit(value, ctx, acc)

          other, acc ->
            visit(other, ctx, acc)
        end)
    end
  end

  # A plain map, an update `%{m | k: v}` included.
  defp visit({:%{}, _, pairs}, ctx, acc), do: visit_all(pairs, ctx, acc)

  defp visit({:=, _, [left, right]}, ctx, acc) do
    acc = visit(left, %{ctx | mode: :pattern}, acc)
    visit(right, %{ctx | mode: :expr}, acc)
  end

  defp visit({:<-, _, [left, right]}, ctx, acc) do
    acc = visit(left, %{ctx | mode: :pattern}, acc)
    visit(right, %{ctx | mode: :expr}, acc)
  end

  defp visit({:->, _, [heads, body]}, ctx, acc) do
    acc = visit_all(heads, %{ctx | mode: :pattern}, acc)
    visit(body, %{ctx | mode: :expr}, acc)
  end

  defp visit({:when, _, [pattern, guard]}, %{mode: :pattern} = ctx, acc) do
    acc = visit(pattern, ctx, acc)
    visit(guard, %{ctx | mode: :expr}, acc)
  end

  defp visit({:fn, _, clauses}, ctx, acc), do: visit_all(clauses, ctx, acc)

  # Captures: `&M.f/2`, `&f/2`, `&M.f(&1, x)` — references, never invocations.
  defp visit({:&, meta, [inner]}, ctx, acc) do
    case inner do
      {:/, _, [{{:., _, [module_ast, name]}, _, []}, arity]} when is_atom(name) and is_integer(arity) ->
        remote(ctx, acc, module_ast, name, arity, meta, "reference")

      {:/, _, [{name, _, atom}, arity]} when is_atom(name) and is_atom(atom) and is_integer(arity) ->
        raw(acc, "reference", ctx.owner, {:local, ctx.module, name, arity, snapshot(ctx.scope)}, meta, ctx)

      _ ->
        visit(inner, %{ctx | mode: :capture}, acc)
    end
  end

  # `raise`/`reraise`: a throw site (Kernel's, unless shadowed — a local `raise`
  # of the module's own is a call like any other, resolved below).
  defp visit({form, meta, [first | rest]}, ctx, acc)
       when form in [:raise, :reraise] and not is_map_key(ctx, :shadow) do
    acc =
      case first do
        text when is_binary(text) ->
          raw(acc, "throws", ctx.owner, {:module, RuntimeError}, meta, ctx)

        {:<<>>, _, _} ->
          raw(acc, "throws", ctx.owner, {:module, RuntimeError}, meta, ctx)

        _ ->
          case Scope.resolve(ctx.scope, first) do
            nil -> visit(first, ctx, count(acc, :throw_dynamic, meta, ctx, first))
            module -> raw(acc, "throws", ctx.owner, {:module, module}, meta, ctx)
          end
      end

    visit_all(rest, ctx, acc)
  end

  # `apply/2,3` and `:erlang.apply`: dispatch no static reader resolves.
  defp visit({:apply, meta, args}, ctx, acc) when is_list(args) and length(args) in [2, 3] do
    visit_all(args, ctx, count(acc, :dynamic_dispatch, meta, ctx, {:apply, [], args}))
  end

  # Remote call `receiver.f(args)`, or a map access `m.field` (no parens).
  defp visit({{:., _, [receiver, name]}, meta, args}, ctx, acc) when is_atom(name) and is_list(args) do
    case Scope.resolve(ctx.scope, receiver) do
      nil ->
        node = {{:., [], [receiver, name]}, [], args}

        acc =
          if args == [] and Keyword.get(meta, :no_parens, false),
            do: count(acc, :map_access, meta, ctx, node),
            else: count(acc, :dynamic_dispatch, meta, ctx, node)

        acc = visit(receiver, %{ctx | mode: :expr}, acc)
        visit_all(args, %{ctx | mode: :expr}, acc)

      module ->
        kind = if ctx.mode == :capture, do: "reference", else: "invocation"
        acc = remote(ctx, acc, receiver, name, length(args), meta, kind)
        acc = handler_dispatch(module, name, args, meta, ctx, acc)
        visit_all(args, %{ctx | mode: :expr}, acc)
    end
  end

  # A module written as a value: a reference. `__MODULE__` alone is not one.
  defp visit({:__aliases__, meta, _} = ast, ctx, acc) do
    case Scope.resolve(ctx.scope, ast) do
      nil -> count(acc, :dynamic_module, meta, ctx, ast)
      module -> raw(acc, "reference", ctx.owner, {:module, module}, meta, ctx)
    end
  end

  # `x :: spec` inside a binary: the specifier (`size(8)`, `binary-unit(8)`) is syntax, not calls.
  defp visit({:"::", _, [left, _spec]}, ctx, acc), do: visit(left, ctx, acc)

  # Syntax: walk the children only.
  defp visit({form, _, args}, ctx, acc) when form in @syntax and is_list(args), do: visit_all(args, ctx, acc)
  defp visit({form, _, _}, _ctx, acc) when form in @syntax, do: acc

  # A local call — a variable when `args` is an atom (its context).
  defp visit({name, meta, args}, ctx, acc) when is_atom(name) and is_list(args) do
    kind = if ctx.mode == :capture, do: "reference", else: "invocation"
    acc = raw(acc, kind, ctx.owner, {:local, ctx.module, name, length(args), snapshot(ctx.scope)}, meta, ctx)
    visit_all(args, %{ctx | mode: if(ctx.mode == :pattern, do: :pattern, else: :expr)}, acc)
  end

  defp visit({_name, _, atom}, _ctx, acc) when is_atom(atom), do: acc
  defp visit({left, right}, ctx, acc), do: visit_all([left, right], ctx, acc)
  defp visit(list, ctx, acc) when is_list(list), do: visit_all(list, ctx, acc)
  defp visit(_leaf, _ctx, acc), do: acc

  defp visit_all(items, ctx, acc), do: Enum.reduce(items, acc, &visit(&1, ctx, &2))

  # ------------------------------------------------------------- helpers --

  defp remote(ctx, acc, module_ast, name, arity, meta, kind) do
    case Scope.resolve(ctx.scope, module_ast) do
      nil -> count(acc, :dynamic_dispatch, meta, ctx, {{:., [], [module_ast, name]}, [], []})
      module -> raw(acc, kind, ctx.owner, {:function, module, name, arity}, meta, ctx)
    end
  end

  # `GenServer.call(Mod, msg)` / `cast`: the handler the message reaches,
  # when the server is named statically — a `dynamic-candidate` invocation.
  defp handler_dispatch(GenServer, name, [server | _], meta, ctx, acc) when name in [:call, :cast] do
    case Scope.resolve(ctx.scope, server) do
      nil ->
        count(acc, :dynamic_dispatch, meta, ctx, {{:., [], [GenServer, name]}, [], [server]})

      module ->
        handler = if name == :call, do: {:handle_call, 3}, else: {:handle_cast, 2}

        raw(acc, "invocation", ctx.owner, {:handler, module, handler}, meta, ctx,
          provenance: "dynamic-candidate"
        )
    end
  end

  defp handler_dispatch(_module, _name, _args, _meta, _ctx, acc), do: acc

  defp snapshot(%Scope{} = scope), do: %{imports: scope.imports, kernel: scope.kernel, uses: scope.uses}

  defp raw(acc, kind, from, to, meta, ctx, opts \\ []) do
    line = Keyword.get(meta, :line, 1)

    edge = %{
      kind: kind,
      from: from,
      to: to,
      provenance: Keyword.get(opts, :provenance, "declared"),
      anchor: {ctx.file, line, line},
      is_read: Keyword.get(opts, :is_read),
      is_write: Keyword.get(opts, :is_write)
    }

    %{acc | edges: [edge | acc.edges]}
  end

  # A dropped site: counted by reason, and named for `--explain-dropped`.
  defp count(acc, reason, meta, ctx, node) do
    line = Keyword.get(meta, :line, 1)
    what = node |> Macro.to_string() |> String.replace(~r/\s+/, " ") |> String.slice(0, 80)
    site = {reason, "#{ctx.file}:#{line} #{what}"}
    %{acc | counts: Map.update(acc.counts, reason, 1, &(&1 + 1)), sites: [site | acc.sites]}
  end
end
