require "forwardable"

module AcmeOrder
  # An order: its lines and what they add up to.
  class Order < Base
    include Priceable
    extend Forwardable

    # No order holds more lines than this.
    MAX_LINES = 100
    DEFAULT_CURRENCY = "EUR".freeze
    ROUNDINGS = %i[half_up half_even].freeze

    attr_reader :reference, :lines
    attr_accessor :note

    class Line
      attr_reader :sku, :qty

      def initialize(sku, qty = 1)
        @sku = sku
        @qty = qty
      end
    end

    def self.call(*)
      new(*).call
    end

    class << self
      def build(reference, **options, &block)
        new(reference, **options, &block)
      end
    end

    # Builds an order, empty unless lines are given.
    def initialize(reference, lines = [], *rest, currency: DEFAULT_CURRENCY, rounding: :half_up, **options, &block)
      @reference = reference
      @lines = lines
      @currency = currency
      @pricing = Pricing::Standard.new
    end

    def call
      total
    end

    def add(line)
      raise TooManyLines, MAX_LINES if lines.size >= MAX_LINES

      @lines << line
      self.note = "changed"
      self
    end

    def total
      return Money.zero(@currency) if @lines.empty?

      @pricing.price_for(self)
    end

    def price
      total
    end
  end
end
