defmodule AcmeOrder.Money do
  @moduledoc "An amount in minor units with its currency."

  @derive {Jason.Encoder, only: [:amount, :currency]}
  defstruct amount: 0, currency: "EUR"

  @type t :: %__MODULE__{amount: integer(), currency: String.t()}

  def zero, do: %__MODULE__{}

  def new(amount, currency \\ "EUR") when is_integer(amount), do: %__MODULE__{amount: amount, currency: currency}

  def add(%__MODULE__{currency: c} = a, %__MODULE__{currency: c} = b), do: %__MODULE__{a | amount: a.amount + b.amount}
  def add(%__MODULE__{}, %__MODULE__{}), do: raise(ArgumentError, "currency mismatch")

  defimpl String.Chars do
    def to_string(%AcmeOrder.Money{amount: amount, currency: currency}), do: "#{amount} #{currency}"
  end
end
