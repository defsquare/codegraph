defmodule AcmeOrder.OrderTest do
  use ExUnit.Case, async: true
  alias AcmeOrder.{Order, Line}

  test "an empty order totals zero" do
    assert Order.total(Order.create("R-1")) == AcmeOrder.Money.zero()
  end

  test "adding a line" do
    order = Order.add_line(Order.create("R-2"), %Line{sku: "A", qty: 1, unit: 100})
    assert length(order.lines) == 1
  end
end
