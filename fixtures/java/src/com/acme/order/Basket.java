package com.acme.order;

import java.util.ArrayList;
import java.util.List;

/** A basket being filled. Declares no constructor of its own. */
public class Basket {

    private long total;

    private final List<Line> lines = new ArrayList<>();

    public void add(Line line) {
        lines.add(line);
        total += line.amount();
    }

    public long total() {
        return total;
    }

    public Cursor cursor() {
        return new Cursor();
    }

    /** Static nested: no enclosing Basket instance. */
    public static class Line {

        private final long amount;

        public Line(long amount) {
            this.amount = amount;
        }

        public long amount() {
            return amount;
        }

        /** Nested inside a nested type. */
        public static class Discount {

            public long applyTo(long amount) {
                return amount / 2;
            }
        }
    }

    /** Non-static inner: reads the enclosing Basket's fields. */
    public class Cursor {

        private int index;

        public Line next() {
            return lines.get(index++);
        }
    }
}
