defmodule AcmeOrder.Notifier do
  @moduledoc "Nested modules, scoped aliases, and a Kernel override."
  import Kernel, except: [length: 1]
  alias AcmeOrder.{Order, Money}
  alias AcmeOrder.Pricing.Standard, as: Pricing
  require Logger
  use AcmeOrder.Macros, channel: :phone

  defmodule Email do
    @moduledoc false
    def deliver(%Order{} = order), do: {:email, Order.describe(order)}
  end

  defmodule Sms.Gateway do
    def deliver(text), do: {:sms, text}
  end

  def notify(order) do
    alias AcmeOrder.Notifier.Email, as: Mail
    Logger.info("notifying")
    Email.deliver(order)
    Mail.deliver(order)
    Sms.Gateway.deliver("shipped")
    Pricing.discount(Money.zero(), pct: 10)
    length(order.lines)
  end

  def length(list) when is_list(list), do: Enum.count(list)
end
