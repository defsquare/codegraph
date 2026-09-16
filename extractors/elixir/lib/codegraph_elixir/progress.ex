defmodule CodegraphElixir.Progress do
  @moduledoc """
  One line per phase on stderr (`--progress plain`), nothing when piped
  (`auto` while stderr is not a terminal) or silenced. stderr is a read
  format here — the summary lands on it — so a redirected run is
  byte-identical to one without progress at all.
  """

  defstruct enabled?: false, sink: nil

  def new(mode, sink, terminal?) do
    %__MODULE__{enabled?: mode == :plain or (mode == :auto and terminal?), sink: sink}
  end

  def silent, do: %__MODULE__{enabled?: false, sink: fn _ -> :ok end}

  def phase(%__MODULE__{enabled?: false}, _name, work, _detail), do: work.()

  def phase(%__MODULE__{sink: sink}, name, work, detail) do
    started = System.monotonic_time(:microsecond)
    result = work.()
    seconds = (System.monotonic_time(:microsecond) - started) / 1_000_000

    sink.(
      "✓ #{String.pad_trailing(name, 10)} #{detail.(result)}  #{:erlang.float_to_binary(seconds, decimals: 1)}s\n"
    )

    result
  end
end
