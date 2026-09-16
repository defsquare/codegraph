defmodule AcmeOrder.Reporting do
  alias AcmeOrder.Order

  @spec describe_order(Order.t()) :: String.t()
  def describe_order(%Order{reference: reference} = order) do
    "#{reference}: #{Order.total(order)}"
  end
end
