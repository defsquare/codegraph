module AcmeOrder
  module Pricing
    class Standard < Base
      def price_for(order)
        order.lines.sum
      end
    end
  end
end
