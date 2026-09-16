import Config

config :acme_order, AcmeOrder.Repo, database: "acme_order_dev", pool_size: 5

config :acme_order, ecto_repos: [AcmeOrder.Repo]
