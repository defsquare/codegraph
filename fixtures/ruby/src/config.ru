require "acme_order"

run ->(_env) { [200, {}, [AcmeOrder.root]] }
