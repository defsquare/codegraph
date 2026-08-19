package com.acme.order;

/**
 * Array members and an anonymous class that uses its own members.
 *
 * <p>Both were blind spots found by auditing a real corpus (commons-lang), not by
 * this corpus: arrays were present but nothing ever read `array.length`, and an
 * anonymous class was present but nothing inside it touched its own fields.
 *
 * <p>`counts.length` and `int[]::new` declare their member on the ARRAY type. An
 * array is not an entity, and its component type does not own those members —
 * attributing them to the component invented a stub class named `int` and an
 * access on `com.acme.order.Money` that the source never writes.
 *
 * <p>The anonymous `Priceable` is identified by `#file:line`; Spoon names it
 * `Batch$1`, so any edge that names it from a type REFERENCE must be translated
 * back, or one declared class ends up with two ids and the second is laundered
 * into a stub carrying the corpus's own package.
 */
public class Batch {

    private final int[] counts;

    private final Money[] prices;

    public Batch(int[] counts, Money[] prices) {
        this.counts = counts;
        this.prices = prices;
    }

    /** `counts.length` — a field of `int[]`, not of `int`. */
    public int size() {
        return counts.length;
    }

    /** `prices.length` — a field of `Money[]`, not of `Money`. */
    public int priced() {
        return prices.length;
    }

    /** `int[]::new` — a constructor declared on the array type. */
    public java.util.function.IntFunction<int[]> allocator() {
        return int[]::new;
    }

    /** An anonymous class that reads its own field and calls its own method. */
    public Priceable running() {
        return new Priceable() {

            private final Money running = Money.zero();

            @Override
            public Money price() {
                return scaled(running);
            }

            private Money scaled(Money base) {
                return base;
            }
        };
    }
}
