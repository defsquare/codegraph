module AcmeOrder
  # An amount in one currency.
  class Money < Struct.new(:cents, :currency)
    include Comparable

    def self.zero(currency = "EUR")
      new(0, currency)
    end

    def +(other)
      Money.new(cents + other.cents, currency)
    end

    def /(divisor)
      Money.new(cents / divisor, currency)
    end

    def %(divisor)
      Money.new(cents % divisor, currency)
    end

    def <=>(other)
      cents <=> other.cents
    end
  end
end
