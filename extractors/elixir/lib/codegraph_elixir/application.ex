defmodule CodegraphElixir.Application do
  @moduledoc """
  The entry point of the Burrito BINARY: a release starts the application,
  and this one runs the CLI on the wrapped arguments and halts with its exit
  code. The escript never starts the application (`escript: [app: nil]`):
  its entry is `CodegraphElixir.CLI.main/1` directly.
  """

  use Application

  @impl Application
  def start(_type, _args) do
    # Under `mix test` / `mix run` the application starts too: only the
    # wrapped binary runs the CLI. Burrito's launcher names itself in
    # `__BURRITO_BIN_PATH` and passes the command line after `-extra`, so
    # `:init.get_plain_arguments/0` is the argv — read here, BEFORE the
    # release's `elixir start_cli` would parse it as Elixir's own options,
    # and the CLI halts the VM before that ever runs.
    if System.get_env("__BURRITO_BIN_PATH") do
      CodegraphElixir.CLI.main(Enum.map(:init.get_plain_arguments(), &to_string/1))
    end

    Supervisor.start_link([], strategy: :one_for_one)
  end
end
