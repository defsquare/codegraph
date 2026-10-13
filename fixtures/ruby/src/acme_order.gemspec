require_relative "lib/acme_order/version"

Gem::Specification.new do |spec|
  spec.name = "acme_order"
  spec.version = AcmeOrder::VERSION
  spec.summary = "Orders, lines and prices"
  spec.files = Dir["lib/**/*.rb"]
  spec.add_dependency "activerecord"
end
