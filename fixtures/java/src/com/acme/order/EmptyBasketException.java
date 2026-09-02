package com.acme.order;

/** The corpus-declared exception the throw-site regression case targets. */
public class EmptyBasketException extends RuntimeException {

    public EmptyBasketException(String message) {
        super(message);
    }
}
