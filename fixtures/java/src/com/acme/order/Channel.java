package com.acme.order;

/** Where an order came from. */
public enum Channel implements Priceable {
    WEB,
    PHONE,
    STORE;

    @Override
    public Money price() {
        return Money.zero();
    }
}
