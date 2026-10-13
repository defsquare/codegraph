# Sorts before order.rb: the body that writes a superclass is still the primary declaration.
class AcmeOrder::Order
  def audit
    self
  end
end
