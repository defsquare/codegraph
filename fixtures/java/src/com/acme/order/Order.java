package com.acme.order;

import com.megacorp.ledger.LedgerClient;

/** A customer order. The one-argument constructor delegates to the other. */
public class Order extends AbstractOrder {

    /** A compile-time constant: the initializer folds across the arithmetic. */
    public static final int MAX_LINES = 4 * 25;

    /** Final, but NOT a constant: an initializer that is code carries no value. */
    private final StringBuilder trail = new StringBuilder();

    private final Channel channel;

    public Order(String reference) {
        this(reference, Channel.WEB);
    }

    public Order(String reference, Channel channel) {
        super(reference);
        this.channel = channel;
    }

    public Channel channel() {
        return channel;
    }

    @Audited(LedgerClient.AUDIT_TAG)
    @Override
    public Money discount(int percent) {
        // `total` is inherited from AbstractOrder, not declared here.
        return total.times(100 - percent);
    }
}
