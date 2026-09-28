/**
 * Money formatting.
 *
 * The rule this file exists to enforce: a minor-unit integer is the source of
 * truth and is never converted to a float for storage or arithmetic. Division
 * happens exactly once, here, at the moment a human reads the number.
 *
 * `exponent` is not decoration. It is the reason `currencies.exponent` is a
 * column: JPY has 0, USD has 2, and a system that hardcodes "divide by 100"
 * displays a 1000-yen price as 10 yen. The value comes from the database, so a
 * new currency needs a row, not a code change.
 */

/** The default is the overwhelmingly common case, but callers should pass the
 *  exponent they were given rather than relying on this. */
export const DEFAULT_EXPONENT = 2;

export interface Money {
  /** Integer minor units exactly as stored. */
  readonly minor: number;
  readonly currencyCode: string;
  readonly exponent: number;
}

export function money(minor: number, currencyCode: string, exponent = DEFAULT_EXPONENT): Money {
  return { minor, currencyCode, exponent };
}

/**
 * Renders minor units for display.
 *
 * The division is the only float in the money path, and it happens after the
 * value has already been decided. `Intl` handles digit grouping and symbol
 * placement for the locale; we only supply the already-correct major-unit
 * amount.
 */
export function formatMoney(value: Money, locale = 'en-NG'): string {
  const amount = value.exponent === 0 ? value.minor : value.minor / 10 ** value.exponent;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: value.currencyCode,
    }).format(amount);
  } catch {
    // An unknown or malformed currency code makes Intl throw. Falling back to
    // the raw minor units with the code is honest: a wrong-looking price is
    // better than a 500 that says nothing.
    return `${value.minor} ${value.currencyCode} (minor units)`;
  }
}

/** Basis points to a 0..1 multiplier: 750 bp -> 0.075. */
export function basisPointsToRate(bp: number): number {
  return bp / 10_000;
}
