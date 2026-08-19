package com.acme.order.legacy;

/** A hand-rolled cons list from before java.util was allowed here. */
public class List {

    private final String head;

    private final List tail;

    public List(String head, List tail) {
        this.head = head;
        this.tail = tail;
    }

    public String head() {
        return head;
    }

    public int length() {
        return tail == null ? 1 : 1 + tail.length();
    }
}
