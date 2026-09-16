defmodule AcmeOrder.Pricing.Premium do
  @behaviour AcmeOrder.Pricing
  alias AcmeOrder.Pricing.Standard

  @impl true
  def price(line, :phone), do: Standard.price(line, :phone) |> Standard.discount(pct: 5)
  def price(line, channel), do: Standard.price(line, channel)
end
