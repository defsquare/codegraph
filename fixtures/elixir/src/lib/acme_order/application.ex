defmodule AcmeOrder.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      AcmeOrder.Repo,
      {AcmeOrder.Stock, name: AcmeOrder.Stock},
      {Registry, keys: :unique, name: AcmeOrder.Registry}
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: AcmeOrder.Supervisor)
  end
end
