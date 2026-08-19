package com.acme.order;

/** kind `enum`: implements, never extends. */
public enum Channel {
  WEB,
  STORE;

  public boolean online() {
    return this == WEB;
  }
}
