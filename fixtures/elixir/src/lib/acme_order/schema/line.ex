defmodule AcmeOrder.Line do
  @moduledoc "An order line, persisted."
  use Ecto.Schema
  import Ecto.Changeset
  import Ecto.Query, only: [from: 2]

  @type t :: %__MODULE__{}

  schema "lines" do
    field :sku, :string
    field :qty, :integer, default: 1
    field :unit, :integer
    belongs_to :order, AcmeOrder.Order
    timestamps()
  end

  def changeset(line, attrs) do
    line
    |> cast(attrs, [:sku, :qty, :unit])
    |> validate_required([:sku, :unit])
    |> validate_number(:qty, greater_than: 0)
  end

  def for_sku(sku), do: from(l in __MODULE__, where: l.sku == ^sku)
end
