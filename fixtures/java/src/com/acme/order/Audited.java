package com.acme.order;

/** kind `annotation`: neither extends nor implements. */
public @interface Audited {
  String value() default "";
}
