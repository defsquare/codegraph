defmodule CodegraphElixir.Trace do
  @moduledoc """
  The `--trace` enrichment (PLAN.md §16.5): what the compiler binds AFTER
  macro expansion, written by `mix codegraph.trace` inside a project that
  compiles, read by the extractor to add what the parser could not see.

  A compilation tracer receives every resolved call — remote, local,
  imported, function or macro — and every struct expansion with the
  caller's environment: file, line, module, and the function being
  defined. The trace file is JSONL, one event per line, paths relative to
  the project root:

      {"t":"trace","elixir":"1.18.4","otp":"27","root":"/abs/project"}
      {"t":"call","k":"remote","file":"lib/a.ex","line":12,"from":["Elixir.A","f",1],"to":["Elixir.B","g",2]}
      {"t":"call","k":"local","file":"lib/a.ex","line":13,"from":["Elixir.A","f",1],"to":["Elixir.A","h",0]}
      {"t":"struct","file":"lib/a.ex","line":14,"from":["Elixir.A","f",1],"to":"Elixir.B"}

  `from` has one element when the site is the module body (compile-time
  code, what `use` expands). Keys never come from the trace: the extractor
  assigns them from source, the trace only closes edges between them.
  """

  @table :codegraph_elixir_trace

  defmodule Tracer do
    @moduledoc "The compiler tracer: `Code.put_compiler_option(:tracers, [Tracer])` before compiling."

    @table :codegraph_elixir_trace

    def trace({:remote_function, meta, module, name, arity}, env),
      do: call(:remote, meta, module, name, arity, env)

    def trace({:remote_macro, meta, module, name, arity}, env),
      do: call(:remote, meta, module, name, arity, env)

    def trace({:imported_function, meta, module, name, arity}, env),
      do: call(:imported, meta, module, name, arity, env)

    def trace({:imported_macro, meta, module, name, arity}, env),
      do: call(:imported, meta, module, name, arity, env)

    def trace({:local_function, meta, name, arity}, env), do: call(:local, meta, env.module, name, arity, env)
    def trace({:local_macro, meta, name, arity}, env), do: call(:local, meta, env.module, name, arity, env)

    def trace({:struct_expansion, meta, module, _keys}, env) do
      record({:struct, env.file, line(meta, env), from(env), module})
    end

    def trace(_event, _env), do: :ok

    defp call(kind, meta, module, name, arity, env) do
      record({:call, kind, env.file, line(meta, env), from(env), {module, name, arity}})
    end

    defp record(event) do
      if :ets.whereis(@table) != :undefined, do: :ets.insert(@table, {event})
      :ok
    end

    defp line(meta, env), do: Keyword.get(meta, :line) || env.line || 0

    defp from(%{module: module, function: nil}), do: {module}
    defp from(%{module: module, function: {name, arity}}), do: {module, name, arity}
  end

  @doc "Create the event table (public, so every compiler process can write)."
  def start do
    if :ets.whereis(@table) == :undefined do
      :ets.new(@table, [:duplicate_bag, :public, :named_table])
    end

    :ok
  end

  def stop do
    if :ets.whereis(@table) != :undefined, do: :ets.delete(@table)
    :ok
  end

  @doc "Write every recorded event, sorted, as JSONL; paths relative to `root`."
  def write(path, root) do
    events =
      @table
      |> :ets.tab2list()
      |> Enum.map(fn {event} -> event end)
      |> Enum.uniq()
      |> Enum.map(&encode(&1, root))
      |> Enum.reject(&is_nil/1)
      |> Enum.sort()

    header =
      JSON.encode!(%{
        t: "trace",
        elixir: System.version(),
        otp: to_string(:erlang.system_info(:otp_release)),
        root: root
      })

    File.write!(path, [header, "\n", Enum.map(events, &[&1, "\n"])])
    length(events)
  end

  defp encode({:call, kind, file, line, from, {module, name, arity}}, root) do
    with {:ok, rel} <- relative(file, root) do
      JSON.encode!(%{
        t: "call",
        k: Atom.to_string(kind),
        file: rel,
        line: line,
        from: from_list(from),
        to: [Atom.to_string(module), Atom.to_string(name), arity]
      })
    else
      _ -> nil
    end
  end

  defp encode({:struct, file, line, from, module}, root) do
    with {:ok, rel} <- relative(file, root) do
      JSON.encode!(%{
        t: "struct",
        file: rel,
        line: line,
        from: from_list(from),
        to: Atom.to_string(module)
      })
    else
      _ -> nil
    end
  end

  # `[module]` for a module body, `[module, name, arity]` with the arity a NUMBER.
  defp from_list({module}), do: [Atom.to_string(module)]
  defp from_list({module, name, arity}), do: [Atom.to_string(module), Atom.to_string(name), arity]

  # A file outside the project (a dependency's) is not corpus: skipped.
  defp relative(file, root) do
    file = to_string(file)
    root = String.trim_trailing(to_string(root), "/") <> "/"

    if String.starts_with?(file, root),
      do: {:ok, String.replace(String.replace_prefix(file, root, ""), "\\", "/")},
      else: :error
  end

  @doc """
  Read a trace file: `{:ok, %{root: …, events: [event]}}` where an event is
  `%{kind: :remote | :local | :imported | :struct, file, line, from: {module} |
  {module, name, arity}, to: {module, name, arity} | module}`.
  """
  def read(path) do
    case File.read(path) do
      {:ok, text} ->
        lines = text |> String.split("\n") |> Enum.reject(&(&1 == ""))

        case lines do
          [] -> {:error, "empty trace"}
          [header | rest] -> parse(header, rest)
        end

      {:error, reason} ->
        {:error, "cannot read #{path}: #{:file.format_error(reason)}"}
    end
  end

  defp parse(header, lines) do
    with {:ok, %{"t" => "trace"} = head} <- JSON.decode(header) do
      events =
        lines
        |> Enum.map(&JSON.decode!/1)
        |> Enum.map(&event/1)
        |> Enum.reject(&is_nil/1)

      {:ok, %{root: head["root"], elixir: head["elixir"], events: events}}
    else
      _ -> {:error, "not a codegraph trace (no header)"}
    end
  end

  defp event(%{"t" => "call", "k" => k, "file" => file, "line" => line, "from" => from, "to" => [m, f, a]}) do
    %{
      kind: String.to_atom(k),
      file: file,
      line: line,
      from: from(from),
      to: {String.to_atom(m), String.to_atom(f), a}
    }
  end

  defp event(%{"t" => "struct", "file" => file, "line" => line, "from" => from, "to" => m}) do
    %{kind: :struct, file: file, line: line, from: from(from), to: String.to_atom(m)}
  end

  defp event(_), do: nil

  defp from([m]), do: {String.to_atom(m)}
  defp from([m, f, a]), do: {String.to_atom(m), String.to_atom(f), a}

  # ------------------------------------------------------------------ merge --

  alias CodegraphElixir.{Extraction, ExtractionError, Paths}
  alias CodegraphElixir.Model.{Edge, Key}

  @doc """
  Merge a trace into the closed baseline: every event whose site lies under
  the corpus root and whose caller the corpus declares becomes an edge —
  `generated` when the baseline did not already write it, resolved through
  the same closing rules (a stub module for an external callee, dropped
  when nothing binds). Keys never come from the trace.
  """
  def merge(nil, _corpus, _world, edges, stubs, stats), do: {edges, stubs, stats}

  def merge(path, corpus, world, edges, stubs, stats) do
    trace =
      case read(path) do
        {:ok, trace} -> trace
        {:error, message} -> raise ExtractionError, "--trace: #{message}"
      end

    known = MapSet.new(edges, &signature/1)

    counts = %{
      events: length(trace.events),
      added: 0,
      known: 0,
      kernel: 0,
      unplaced: 0,
      injected: 0,
      dropped: 0
    }

    {added, _known, stubs, counts} =
      Enum.reduce(trace.events, {[], known, stubs, counts}, fn event, {added, known, stubs, counts} ->
        with {:ok, rel} <- place(event.file, trace.root, corpus.root),
             {:ok, from} <- caller(event.from, world) do
          # A generated definition (`__struct__/1`) has no line: it lands on line 1.
          line = max(event.line, 1)

          raw = %{
            kind: kind(event),
            from: from,
            to: target(event),
            provenance: "generated",
            anchor: {rel, line, line},
            is_read: nil,
            is_write: nil
          }

          case Extraction.resolve(raw, world, stubs) do
            {:ok, to, candidates, stubs, _external?} ->
              edge = %Edge{
                kind: raw.kind,
                from: from,
                to: to,
                provenance: if(candidates == nil, do: "generated", else: "dynamic-candidate"),
                anchor: raw.anchor,
                candidates: candidates
              }

              cond do
                Key.index(from) == Key.index(to) -> {added, known, stubs, bump(counts, :known)}
                MapSet.member?(known, signature(edge)) -> {added, known, stubs, bump(counts, :known)}
                true -> {[edge | added], MapSet.put(known, signature(edge)), stubs, bump(counts, :added)}
              end

            {:kernel, stubs} ->
              {added, known, stubs, bump(counts, :kernel)}

            # A call to a function the module does not declare in source: an
            # injected definition, which has no entity to land on.
            {:drop, :remote_unbound, stubs} ->
              {added, known, stubs, bump(counts, :injected)}

            {:drop, _reason, stubs} ->
              {added, known, stubs, bump(counts, :dropped)}
          end
        else
          _ -> {added, known, stubs, bump(counts, :unplaced)}
        end
      end)

    {edges ++ Enum.reverse(added), stubs, %{stats | trace: counts}}
  end

  # An edge the baseline wrote at the same site is the same fact, not a generated one.
  defp signature(%Edge{} = edge), do: {edge.kind, Key.index(edge.from), Key.index(edge.to), edge.anchor}

  defp bump(counts, key), do: Map.update!(counts, key, &(&1 + 1))

  defp kind(%{kind: :struct}), do: "reference"
  defp kind(_event), do: "invocation"

  defp target(%{kind: :struct, to: module}), do: {:module, module}
  defp target(%{to: {module, name, arity}}), do: {:function, module, name, arity}

  # The trace's paths are relative to ITS root; the model's to the corpus root.
  defp place(file, trace_root, corpus_root) do
    full = Paths.slashes(Path.join(trace_root, file))

    if Paths.under?(full, corpus_root),
      do: {:ok, Paths.relative_to(corpus_root, full)},
      else: :error
  end

  # The caller: a declared function of a corpus module, else the module itself
  # (compile-time code, or a definition a macro injected), else nowhere.
  defp caller({module}, world) do
    case Map.fetch(world.whitelist, module) do
      {:ok, declared} -> {:ok, declared.key}
      :error -> :error
    end
  end

  defp caller({module, name, arity}, world) do
    case Extraction.declared_function(world, module, name, arity) do
      nil -> caller({module}, world)
      key -> {:ok, key}
    end
  end
end
