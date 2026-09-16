defmodule AcmeOrder.Promo2024 do
  alias AcmeOrder.Money
  def apply(%Money{amount: amount} = money), do: %Money{money | amount: div(amount * 9, 10)}
end
