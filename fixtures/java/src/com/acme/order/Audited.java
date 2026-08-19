package com.acme.order;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

/** Marks a method whose calls must reach the audit log. */
@Retention(RetentionPolicy.RUNTIME)
public @interface Audited {

    String value() default "";
}
