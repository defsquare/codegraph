require "acme_order"

namespace :orders do
  task :report do
    puts AcmeOrder::VERSION
  end
end
