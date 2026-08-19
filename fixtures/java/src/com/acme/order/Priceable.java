package com.acme.order;

/** Anything the pricing engine can put a number on. */
public interface Priceable {

    Money price();
}
