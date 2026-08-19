package com.acme.order;

/** kind `record`. Its canonical constructor and accessors are implicit — Spoon
 * reports them without a valid source position. */
public record Order(String id, double amount) {}
