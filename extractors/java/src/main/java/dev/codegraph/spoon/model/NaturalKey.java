package dev.codegraph.spoon.model;

import java.util.Comparator;
import java.util.Objects;

/**
 * Structured identity (METAMODEL.md §1.1, MM-1): {@code (lang, module, symbol,
 * disambiguator?)}. This is what the JSONL interchange carries — {@code m}/
 * {@code s}/{@code d} on an entity record, with {@code lang} in the header —
 * and no rendered id string is written to a model file at all.
 *
 * <p><b>Why the extractor may decode its own ids.</b> {@link EntityIds} builds
 * rendered ids by concatenation and every pass downstream of it passes those
 * strings around. Rendering is injective (the reserved separators below), so
 * {@link #parse} is an exact inverse, not a guess — and {@link #parse} proves it
 * on every call by re-rendering and comparing. CLAUDE.md invariant 7 forbids
 * CONSUMERS parsing ids because inferring meaning from an id is how Spoon's
 * invented FQNs would get laundered into facts; decoding a bijection the
 * extractor itself produced is a different act. Nothing outside this package
 * and {@code EntityIds} may do it.
 *
 * <p>A <b>module names itself</b>: its key is {@code (lang, itsOwnPath, "")}, so
 * {@code java:com.acme.order} renders unchanged. Making a module's key point at
 * its PARENT would render it {@code java:com.acme/order} and would need a
 * fabricated {@code java} module to place the stub package {@code java:java.util},
 * whose parent no corpus declares.
 */
public record NaturalKey(String lang, String module, String symbol, String disambiguator)
    implements Comparable<NaturalKey> {

  /**
   * Canonical model order: component by component, an absent disambiguator
   * before any present one, comparing by UTF-16 code unit as the TypeScript
   * side does. This order IS the surrogate assignment.
   */
  public static final Comparator<NaturalKey> CANONICAL_ORDER =
      Comparator.comparing(NaturalKey::lang)
          .thenComparing(NaturalKey::module)
          .thenComparing(NaturalKey::symbol)
          .thenComparing(
              NaturalKey::disambiguator, Comparator.nullsFirst(Comparator.naturalOrder()));

  public NaturalKey {
    requireNoSeparator(lang, ':', "lang");
    requireNoSeparator(module, '/', "module");
    requireNoSeparator(module, '#', "module");
    requireNoSeparator(symbol, '#', "symbol");
    if (lang == null || lang.isEmpty()) {
      throw new IllegalArgumentException("lang must not be empty");
    }
    if (module == null || module.isEmpty()) {
      throw new IllegalArgumentException("module must not be empty");
    }
    if (symbol == null) {
      throw new IllegalArgumentException("symbol must not be null (empty means: this is a module)");
    }
    if (disambiguator != null && disambiguator.isEmpty()) {
      // An empty disambiguator would render as a bare trailing '#' — a second
      // spelling of "no disambiguator", which would break injectivity.
      throw new IllegalArgumentException("disambiguator must be absent or non-empty");
    }
  }

  /** True when this key identifies a module, which is exactly when it names itself. */
  public boolean isModule() {
    return symbol.isEmpty() && disambiguator == null;
  }

  /** The display projection: {@code <lang>:<module>[/<symbol>][#<disambiguator>]}. */
  public String render() {
    StringBuilder out = new StringBuilder(lang).append(':').append(module);
    if (!symbol.isEmpty()) {
      out.append('/').append(symbol);
    }
    if (disambiguator != null) {
      out.append('#').append(disambiguator);
    }
    return out.toString();
  }

  /**
   * The inverse of {@link #render}: split at the first {@code :}, then the first
   * {@code #}, then the first {@code /}. Verifies the round trip, because
   * decoding is exact only ON render's image — {@code l:m/#d} is not, and would
   * silently come back as the DIFFERENT id {@code l:m#d}.
   */
  public static NaturalKey parse(String id) {
    Objects.requireNonNull(id, "id");
    int colon = id.indexOf(':');
    if (colon < 1) {
      throw new IllegalArgumentException("not a rendered id (no lang prefix): " + id);
    }
    String lang = id.substring(0, colon);
    String body = id.substring(colon + 1);

    int hash = body.indexOf('#');
    String head = hash < 0 ? body : body.substring(0, hash);
    String disambiguator = hash < 0 ? null : body.substring(hash + 1);

    int slash = head.indexOf('/');
    String module = slash < 0 ? head : head.substring(0, slash);
    String symbol = slash < 0 ? "" : head.substring(slash + 1);

    NaturalKey key = new NaturalKey(lang, module, symbol, disambiguator);
    if (!key.render().equals(id)) {
      throw new IllegalArgumentException(
          "not a rendered id (it is not what render() would produce for its own components): " + id);
    }
    return key;
  }

  @Override
  public int compareTo(NaturalKey other) {
    return CANONICAL_ORDER.compare(this, other);
  }

  private static void requireNoSeparator(String value, char separator, String what) {
    if (value != null && value.indexOf(separator) >= 0) {
      throw new IllegalArgumentException(
          what + " must not contain '" + separator + "' — it is a reserved separator: " + value);
    }
  }
}
