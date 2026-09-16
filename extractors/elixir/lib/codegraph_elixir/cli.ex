defmodule CodegraphElixir.CLI do
  @moduledoc """
  The extractor as a program (schemas/README.md §8): argv in, exit code out,
  every byte through an injected `Io`. `stdout` carries nothing but
  `--help`/`--version`; progress and the resolution summary go to `stderr`,
  so a redirected run is byte-identical to a silent one.
  """

  alias CodegraphElixir.{Extraction, Options, Progress}
  alias CodegraphElixir.Model.Writer

  @version Mix.Project.config()[:version]

  @exit_ok 0
  @exit_failure 1
  @exit_usage 2
  @exit_unimplemented 3

  defmodule Io do
    @moduledoc "Two sinks; `terminal?` decides whether `--progress auto` prints."
    @enforce_keys [:stdout, :stderr]
    defstruct [:stdout, :stderr, stdout_terminal?: false, stderr_terminal?: false]
  end

  def version, do: @version

  @doc "The escript entry point."
  def main(argv) do
    io = %Io{
      stdout: &IO.write(:stdio, &1),
      stderr: &IO.write(:stderr, &1),
      stderr_terminal?: terminal?(:standard_error)
    }

    code = run(argv, io, File.cwd!())
    # An escript halts explicitly so buffered output is flushed first.
    System.halt(code)
  end

  @doc "Runs the extractor; returns the exit code and writes nothing itself."
  @spec run([String.t()], %Io{}, String.t()) :: non_neg_integer()
  def run(argv, %Io{} = io, cwd) do
    case Options.parse(argv, cwd) do
      {:error, message} ->
        io.stderr.("error: #{message}\n\n" <> Options.usage(@version))
        @exit_usage

      {:ok, %Options{help: true}} ->
        io.stdout.(Options.usage(@version))
        @exit_ok

      {:ok, %Options{version: true}} ->
        io.stdout.("#{@version}\n")
        @exit_ok

      {:ok, %Options{trace: trace}} when trace != nil ->
        io.stderr.("error: --trace is not implemented yet (PLAN.md §16.5, M15c)\n")
        @exit_unimplemented

      {:ok, %Options{deps: deps}} when deps != nil ->
        io.stderr.("error: --deps is not implemented yet (PLAN.md §16.4, M15b)\n")
        @exit_unimplemented

      {:ok, options} ->
        extract(options, io, cwd)
    end
  end

  defp extract(options, io, cwd) do
    progress = Progress.new(options.progress, io.stderr, io.stderr_terminal?)
    result = Extraction.run(options, progress, @version, cwd)

    Progress.phase(progress, "write", fn -> write_lines(options.out, Writer.encode(result.model)) end, fn n ->
      "#{n} records"
    end)

    for path <- result.stats.unparsed, do: io.stderr.("unparsed (skipped): #{path}\n")
    for dup <- result.stats.duplicate_keys, do: io.stderr.("duplicate declaration re-keyed: #{dup}\n")
    io.stderr.(CodegraphElixir.Stats.summary(result.stats, result.model))
    io.stderr.("wrote #{options.out}\n")
    @exit_ok
  rescue
    e in CodegraphElixir.ExtractionError ->
      io.stderr.("error: #{Exception.message(e)}\n")
      @exit_failure
  end

  # Lines to disk in 1MB chunks: never one binary for the whole model.
  defp write_lines(path, lines) do
    File.open!(path, [:write, :binary], fn device ->
      {chunk, size, count} =
        Enum.reduce(lines, {[], 0, 0}, fn line, {chunk, size, count} ->
          bytes = IO.iodata_length(line) + 1
          chunk = [chunk, line, "\n"]

          if size + bytes >= 1_048_576 do
            IO.binwrite(device, chunk)
            {[], 0, count + 1}
          else
            {chunk, size + bytes, count + 1}
          end
        end)

      if size > 0, do: IO.binwrite(device, chunk)
      count
    end)
  end

  defp terminal?(device) do
    case :io.getopts(device) do
      opts when is_list(opts) -> Keyword.get(opts, :terminal, false) == true
      _ -> false
    end
  end
end

defmodule CodegraphElixir.ExtractionError do
  defexception [:message]
end
