module AcmeOrder
  class Error < StandardError; end

  class NotFound < Error; end

  class TooManyLines < Error
    def initialize(max)
      super("more than #{max} lines")
    end
  end
end
