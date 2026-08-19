package com.acme.order;

/** A declared implementation: interfaceImplementation edge to a corpus type. */
public class TaxCalculator implements Taxing {

  private final double rate;

  public TaxCalculator(double rate) {
    this.rate = rate;
  }

  @Override
  public double apply(double amount) {
    double scaled = amount * rate;
    return scaled;
  }
}
