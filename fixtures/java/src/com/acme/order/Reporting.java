package com.acme.order;

import java.time.*;
import java.util.ArrayList;

import static java.util.Arrays.asList;

/** Monthly reporting helpers. */
public class Reporting {

    public ArrayList<String> lines(String... rows) {
        return new ArrayList<>(asList(rows));
    }

    public String join(String[] parts) {
        StringBuilder out = new StringBuilder();
        for (String part : parts) {
            out.append(part);
        }
        return out.toString();
    }

    @Audited("monthly")
    public <T extends Comparable<T>> T max(java.util.List<T> values) {
        T best = null;
        for (T value : values) {
            if (best == null || value.compareTo(best) > 0) {
                best = value;
            }
        }
        return best;
    }

    public <T> T first(java.util.List<T> values) {
        return values.isEmpty() ? null : values.get(0);
    }

    public LocalDate today() {
        return LocalDate.now();
    }
}
