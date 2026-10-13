module AcmeOrder
  class Record < ActiveRecord::Base
    include ActiveModel::Validations

    has_many :lines
    validates :reference, presence: true

    def self.recent
      where(archived: false)
    end

    def archive!
      update!(archived: true)
    end
  end
end
