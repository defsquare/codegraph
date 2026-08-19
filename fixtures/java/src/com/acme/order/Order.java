package com.acme.order;

/** A customer order. The one-argument constructor delegates to the other. */
public class Order extends AbstractOrder {

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

    @Override
    public Money discount(int percent) {
        // `total` is inherited from AbstractOrder, not declared here.
        return total.times(100 - percent);
    }
}
