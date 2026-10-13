module AcmeOrder
  # What including a module ALSO gives the includer, the Rails way.
  module Auditable
    extend ActiveSupport::Concern

    included do
      include Comparable
    end

    class_methods do
      def audited(*names)
        names
      end
    end

    def audit!
      true
    end
  end

  # The same, in plain Ruby: a hook that extends whatever includes it.
  module Stamped
    def self.included(base)
      base.extend(ClassMethods)
    end

    module ClassMethods
      def stamp(name)
        name
      end
    end
  end
end
