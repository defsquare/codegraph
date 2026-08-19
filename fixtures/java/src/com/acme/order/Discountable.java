package com.acme.order;

/** An order that can be marked down. Extends another corpus interface. */
public interface Discountable extends Priceable {

    Money discount(int percent);
}
