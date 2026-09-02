package com.acme.order;

/**
 * Throw-site regression case: a guard clause and a rethrow must each emit a
 * {@code throws} edge anchored at its own statement, and the {@code throws}
 * clause on {@code check} must stay a plain reference (propagation, not a
 * failure exit).
 */
public class StockGuard {

    void ensure(int quantity) {
        if (quantity < 0) {
            throw new EmptyBasketException("negative quantity");
        }
        try {
            check(quantity);
        } catch (EmptyBasketException e) {
            throw e;
        }
    }

    void check(int quantity) throws EmptyBasketException {
    }
}
