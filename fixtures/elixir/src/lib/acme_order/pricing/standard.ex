defmodule AcmeOrder.Pricing.Standard do
  @behaviour AcmeOrder.Pricing

  alias AcmeOrder.{Line, Money}

  @impl true
  def price(%Line{qty: qty, unit: unit}, _channel), do: Money.new(qty * unit)

  @impl AcmeOrder.Pricing
  def discount(%Money{} = money, opts) do
    pct = Keyword.get(opts, :pct, 0)
    Money.new(div(money.amount * (100 - pct), 100), money.currency)
  end
end
