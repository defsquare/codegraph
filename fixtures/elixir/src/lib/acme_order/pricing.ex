defmodule AcmeOrder.Pricing do
  @moduledoc "The pricing behaviour: one price per line and channel."

  alias AcmeOrder.{Line, Money}

  @callback price(Line.t(), atom()) :: Money.t()
  @callback discount(Money.t(), keyword()) :: Money.t()
  @optional_callbacks discount: 2
end
