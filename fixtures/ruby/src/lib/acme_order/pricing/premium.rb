# A compact class opens ONE scope: a bare `Standard` would not be found from here.
class AcmeOrder::Pricing::Premium < AcmeOrder::Pricing::Standard
  include ::AcmeOrder::Priceable

  def price_for(order)
    super * 2
  end
end
