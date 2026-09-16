defmodule AcmeOrder.Repo do
  use Ecto.Repo, otp_app: :acme_order, adapter: Ecto.Adapters.Postgres
end
