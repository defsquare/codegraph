module AcmeOrder
  # Its class methods come from what it includes: no `extend` is written here.
  class Invoice
    include Auditable
    include Stamped

    audited :total
    stamp :issued_at

    def self.build
      audited(:id)
    end

    def self.settle_all(invoices)
      invoices.each { |invoice| invoice.settle }
    end

    def settle
      audit!
    end
  end
end
