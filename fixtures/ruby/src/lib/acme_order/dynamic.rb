module AcmeOrder
  # Everything the extractor refuses to guess, each counted.
  module Dynamic
    require File.join(__dir__, "version")
    require File.join(root, "computed")

    HANDLERS = {}

    Loader = Class.new(Base) do
      def load; end
    end

    class << Loader
      def instance; end
    end

    def Dynamic.helper; end

    include Module.new

    class Wrapped < Loader; end

    class Odd < HANDLERS; end

    class Ghost
      define_method(:ping) { pong }
      define_method("#{name}_later") { 1 }

      def pong
        send(:ping)
        public_send(name)
        vanish
      end
    end
  end
end
