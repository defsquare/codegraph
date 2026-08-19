package com.acme.order;

/** Minor units only; this fixture has no currencies. */
public record Money(long cents) implements Priceable {

    public static Money zero() {
        return new Money(0L);
    }

    public Money times(int factor) {
        return new Money(cents * factor);
    }

    @Override
    public Money price() {
        return this;
    }
}
