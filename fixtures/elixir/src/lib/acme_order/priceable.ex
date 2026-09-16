defprotocol AcmeOrder.Priceable do
  @moduledoc "Anything that has a price."
  @fallback_to_any true
  def price(item)
  def currency(item)
end

defimpl AcmeOrder.Priceable, for: AcmeOrder.Money do
  def price(money), do: money
  def currency(%{currency: currency}), do: currency
end

defimpl AcmeOrder.Priceable, for: AcmeOrder.Order do
  alias AcmeOrder.Order
  def price(order), do: Order.total(order)
  def currency(_order), do: "EUR"
end

defimpl AcmeOrder.Priceable, for: Any do
  def price(_), do: AcmeOrder.Money.zero()
  def currency(_), do: "EUR"
end
