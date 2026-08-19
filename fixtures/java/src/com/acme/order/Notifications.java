package com.acme.order;

import java.util.function.Consumer;

/** Delivery hooks. Nothing invocable in here has a name of its own. */
public class Notifications {

    private final Consumer<Order> onShipped = order -> log("shipped " + order.reference());

    public Runnable both(Order order) {
        return chain(() -> log("packing " + order.reference()), () -> log("shipping " + order.reference()));
    }

    public Runnable chain(Runnable first, Runnable second) {
        return () -> {
            first.run();
            second.run();
        };
    }

    public Priceable freeOf(Order order) {
        return new Priceable() {

            @Override
            public Money price() {
                log("free " + order.reference());
                return Money.zero();
            }
        };
    }

    public void notifyShipped(Order order) {
        onShipped.accept(order);
    }

    void log(String message) {
        System.out.println(message);
    }
}
