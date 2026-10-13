module AcmeOrder
  # Formats orders for people.
  module Reporting
    module_function

    def summary(order)
      label = Label.new(order.reference)
      label.shout
      "#{label}: #{Money.zero}"
    end

    def annotate(reference)
      order = Order.new(reference)
      order.note = "seen"
      order
    end

    def unnamed?(order)
      order.reference.to_s.blank? || "".blank?
    end
  end
end
