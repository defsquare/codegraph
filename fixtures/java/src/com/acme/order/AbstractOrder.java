package com.acme.order;

/** Shared state for every kind of order. */
public abstract class AbstractOrder implements Discountable {

    protected Money total;

    private final String reference;

    protected AbstractOrder(String reference) {
        this.reference = reference;
        this.total = Money.zero();
    }

    public String reference() {
        return reference;
    }

    @Override
    public Money price() {
        return total;
    }
}
