package com.acme.billing;

/** A declared superclass in a SECOND package: cross-package inheritance + import. */
public abstract class AbstractService {

  protected int processed;

  protected AbstractService() {}

  public abstract String name();
}
