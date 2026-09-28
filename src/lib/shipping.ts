/**
 * The shipping rule, in one place.
 *
 * This exists because two callers need to agree exactly: the seed script, which
 * writes historical orders, and the checkout endpoint, which writes new ones. If
 * they disagree then the seeded data stops being an example of what the API
 * produces, and every comparison made against it is quietly measuring the
 * difference between the two implementations rather than the behaviour of the
 * system.
 *
 * A named export rather than a literal in each file, because a magic number
 * duplicated once is a coincidence and duplicated twice is a divergence waiting
 * to be discovered by a bug report.
 *
 * KNOWN SIMPLIFICATION, stated rather than hidden: the threshold is a flat count
 * of minor units, so it means different amounts in different currencies. That is
 * only correct while the store settles in a single currency, which is exactly
 * what the seed does (every product is priced in NGN). The moment a second
 * currency is listed for sale this has to become either a per-currency table or
 * an explicit rate conversion -- neither of which belongs in a request path, so
 * it is a schema change rather than a code fix.
 */

/** Baskets at or above this subtotal get a flat shipping charge. */
export const FREE_SHIPPING_THRESHOLD_MINOR = 500_000;

/** The flat charge, in minor units, applied above the threshold. */
export const SHIPPING_FLAT_MINOR = 250_000;

/**
 * Shipping owed on a basket of the given subtotal.
 *
 * Note the shape of this rule, because it is also what keeps the write valid
 * against `orders_shipping_not_absurd` (`shipping_minor <= GREATEST(subtotal,
 * 1)`). The flat charge is applied *only* when the subtotal is at least
 * `FREE_SHIPPING_THRESHOLD_MINOR`, which is by definition greater than
 * `SHIPPING_FLAT_MINOR`, so the constraint cannot be violated by this function
 * for any input. That is the reason for two constants rather than one clamped
 * expression, and it is worth preserving if either number changes.
 */
export function shippingMinorFor(subtotalMinor: number): number {
  return subtotalMinor >= FREE_SHIPPING_THRESHOLD_MINOR ? SHIPPING_FLAT_MINOR : 0;
}
