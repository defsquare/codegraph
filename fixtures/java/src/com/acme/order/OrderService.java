package com.acme.order;

import com.megacorp.ledger.LedgerClient;

/**
 * Billing and archival. Both {@code archive} overloads take a parameter whose
 * simple name is {@code List}; only their packages differ.
 */
public class OrderService {

    private final LedgerClient ledger;

    public OrderService(LedgerClient ledger) {
        this.ledger = ledger;
    }

    public Invoice bill(Order order) {
        Invoice invoice = new Invoice(order.reference());
        ledger.post(invoice);
        return invoice;
    }

    public void archive(java.util.List<Order> orders) {
        for (Order order : orders) {
            ledger.archive(order.reference());
        }
    }

    public void archive(com.acme.order.legacy.List orders) {
        ledger.archive(orders.head());
    }
}
