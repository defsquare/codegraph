defmodule AcmeOrder.MixProject do
  use Mix.Project

  def project do
    [app: :acme_order, version: "0.1.0", elixir: "~> 1.18", deps: deps()]
  end

  def application do
    [mod: {AcmeOrder.Application, []}, extra_applications: [:logger]]
  end

  defp deps do
    [{:ecto_sql, "~> 3.12"}, {:jason, "~> 1.4"}]
  end
end
