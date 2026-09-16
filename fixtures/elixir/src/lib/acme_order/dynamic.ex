defmodule AcmeOrder.Dynamic do
  @moduledoc "Dispatch no static reader can resolve."

  def call(mod, fun, args), do: apply(mod, fun, args)

  def price_with(pricing, line), do: pricing.price(line, :web)

  def pricing_for(name), do: Module.concat(AcmeOrder.Pricing, name)

  def send_release(pid, sku), do: GenServer.cast(pid, {:release, sku})
end
