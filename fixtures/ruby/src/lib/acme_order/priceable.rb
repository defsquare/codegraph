module AcmeOrder
  # What has a price.
  module Priceable
    def price
      raise NotImplementedError
    end

    def priced?
      !price.nil?
    end
  end
end
