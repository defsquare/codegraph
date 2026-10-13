module AcmeOrder
  # One library in the chain, and nothing mixed in: what it does not declare is that library's.
  class Ledger < ActiveRecord::Base
    has_many :entries

    %w[open closed].each { |state| define_method("#{state}?") { true } }

    def self.current
      where(closed: false)
    end

    def close!
      update!(closed: true)
    end
  end
end
