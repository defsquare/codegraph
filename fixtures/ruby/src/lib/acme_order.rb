require "bigdecimal"
require "acme_order/version"
require_relative "acme_order/errors"
require_relative "acme_order/base"
require_relative "acme_order/priceable"
require_relative "acme_order/money"
require_relative "acme_order/order"

# The entry point: a body with something of its own, so `AcmeOrder` is declared here.
module AcmeOrder
  autoload :Reporting, "acme_order/reporting"

  def self.root
    __dir__
  end
end
