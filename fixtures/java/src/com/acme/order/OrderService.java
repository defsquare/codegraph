package com.acme.order;

import static java.util.Collections.emptyList;

import com.acme.billing.AbstractService;
import com.nonexistent.external.MissingLib;
import java.util.ArrayList;
import java.util.List;

/**
 * The hazard file. It deliberately mixes three kinds of type reference so that a
 * package-prefix membership test provably produces the wrong answer:
 *
 * <ul>
 *   <li>{@code Order}, {@code TaxCalculator}, {@code Channel} — DECLARED by this corpus;
 *   <li>{@code Invoice} — declared NOWHERE. Spoon in noClasspath mode invents
 *       {@code com.acme.order.Invoice} by assuming the enclosing package, so it is
 *       indistinguishable by prefix from the three above and must still be a stub;
 *   <li>{@code MissingLib}, {@code java.util.List} — outside the corpus. The first is
 *       unresolvable, the second resolves against the JDK: resolvability is not membership.
 * </ul>
 */
@Audited("orders")
public class OrderService extends AbstractService implements Taxing {

  private final TaxCalculator calculator;

  private int billed;

  public OrderService(TaxCalculator calculator) {
    this.calculator = calculator;
  }

  @Override
  public String name() {
    return "orders";
  }

  @Override
  public double apply(double amount) {
    return calculator.apply(amount);
  }

  /** Invoice exists nowhere — Spoon fabricates com.acme.order.Invoice for it. */
  public Invoice bill(Order order) {
    Order copy = order;
    billed++;
    return null;
  }

  /** Overload: same name, different erased parameter types; varargs erase to an array. */
  public Invoice bill(List<Order> orders, String... tags) {
    List<Order> pending = new ArrayList<>(orders);
    return pending.isEmpty() ? null : bill(pending.get(0));
  }

  /** Static import: folded to a module-level import edge on java.util.Collections. */
  public List<Order> none() {
    return emptyList();
  }

  /** kind `lambda`: invocable, nameless, disambiguated by (file, startLine). */
  public Runnable task() {
    return () -> billed++;
  }

  /** Return type is an unresolvable external library type. */
  public MissingLib external() {
    return null;
  }

  /** Nested type: absent from getAllTypes(), reachable only via getNestedTypes(). */
  public static final class Inner {
    void ping() {
      Channel channel = Channel.WEB;
      channel.online();
    }
  }
}
