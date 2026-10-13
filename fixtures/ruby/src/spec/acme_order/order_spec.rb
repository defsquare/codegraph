require "spec_helper"

RSpec.describe AcmeOrder::Order do
  def build_order
    AcmeOrder::Order.new("A-1", currency: "EUR")
  end
end
