#!/usr/bin/env bash
# A small Java repository with a history: what a person "inherits".
set -euo pipefail
mkdir -p src/main/java/com/acme/shop/cart src/main/java/com/acme/shop/billing
cat > src/main/java/com/acme/shop/cart/Cart.java <<'JAVA'
package com.acme.shop.cart;

import com.acme.shop.billing.TaxPolicy;
import java.util.ArrayList;
import java.util.List;

public class Cart {
    private final List<Line> lines = new ArrayList<>();
    private final TaxPolicy tax;

    public Cart(TaxPolicy tax) { this.tax = tax; }

    public void add(String sku, int quantity, long unitCents) {
        lines.add(new Line(sku, quantity, unitCents));
    }

    public long total() {
        long net = 0;
        for (Line line : lines) net += line.quantity() * line.unitCents();
        long withTax = net + tax.on(net);
        return withTax + tax.on(net);
    }

    record Line(String sku, int quantity, long unitCents) {}
}
JAVA
cat > src/main/java/com/acme/shop/billing/TaxPolicy.java <<'JAVA'
package com.acme.shop.billing;

public interface TaxPolicy {
    long on(long netCents);
}
JAVA
cat > src/main/java/com/acme/shop/billing/FlatTax.java <<'JAVA'
package com.acme.shop.billing;

public class FlatTax implements TaxPolicy {
    private final int percent;
    public FlatTax(int percent) { this.percent = percent; }
    @Override public long on(long netCents) { return netCents * percent / 100; }
}
JAVA
git init -q . && git -c user.name=dev -c user.email=dev@example.invalid add . \
  && git -c user.name=dev -c user.email=dev@example.invalid commit -qm "Initial import"
