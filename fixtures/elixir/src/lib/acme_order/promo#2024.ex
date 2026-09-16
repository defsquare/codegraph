defmodule AcmeOrder.Promo2024 do
  alias AcmeOrder.Money
  def apply(%Money{} = money), do: Money.new(div(money.amount * 9, 10), money.currency)
end
