module AcmeOrder
  class Label < String
    def initialize(text = "")
      super(text.strip)
    end

    def shout
      upcase
    end
  end
end
