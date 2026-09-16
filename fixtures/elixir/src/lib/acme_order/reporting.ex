defmodule AcmeOrder.Reporting do
  alias AcmeOrder.{Order, Priceable}

  @spec describe_order(Order.t()) :: String.t()
  def describe_order(%Order{reference: reference} = order) do
    "#{reference}: #{Order.total(order)}"
  end

  @spec price_of(term()) :: AcmeOrder.Money.t()
  def price_of(item), do: Priceable.price(item)

  def stock_snapshot, do: GenServer.call(AcmeOrder.Stock, :peek)
end
