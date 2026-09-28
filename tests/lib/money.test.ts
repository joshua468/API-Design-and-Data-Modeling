/**
 * Money is the one place in this system where a "helpful" float conversion turns
 * a real bug into a subtle one, so it gets tested without a database: the point
 * is to pin the arithmetic, not the plumbing.
 */
import { describe, expect, it } from 'vitest';
import { basisPointsToRate, DEFAULT_EXPONENT, formatMoney, money } from '@/lib/money';

describe('formatMoney', () => {
  it('renders minor units as major units using the currency exponent', () => {
    // 1593750 minor at exponent 2 is 15,937.50 -- the seeded NGN order total.
    expect(formatMoney(money(1_593_750, 'NGN'))).toContain('15,937.50');
  });

  it('does not divide by 100 when the exponent is 0', () => {
    // The whole reason `currencies.exponent` is a column. A hardcoded /100
    // would show a 1000-yen price as 10 yen, which is a 100x error in a price.
    expect(formatMoney(money(1_000, 'JPY', 0))).toContain('1,000');
    expect(formatMoney(money(1_000, 'JPY', 0))).not.toContain('10.00');
  });

  it('defaults to exponent 2 but honours the exponent it is given', () => {
    expect(DEFAULT_EXPONENT).toBe(2);
    expect(formatMoney(money(250, 'USD'))).toBe(formatMoney(money(250, 'USD', 2)));
  });

  it('keeps minor units exact for values a float cannot hold', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. The minor-unit integer never
    // has that problem, which is why it is the stored representation.
    expect(formatMoney(money(30, 'USD'))).toContain('0.30');
  });

  it('falls back to raw minor units for a currency code Intl rejects', () => {
    // Intl only rejects a code that is not three letters -- 'ZZZ' is structurally
    // valid and formats happily as "ZZZ 45.00", which is arguably worse. A
    // two-character code is the case that actually throws, and a price that
    // looks wrong beats a 500 with no number in it, so the fallback names the
    // code and the units rather than swallowing the error.
    expect(() => new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'US' })).toThrow();
    expect(formatMoney(money(4_500, 'US'))).toBe('4500 US (minor units)');
  });
});

describe('basisPointsToRate', () => {
  it('converts 750 basis points to a 7.5% rate', () => {
    expect(basisPointsToRate(750)).toBe(0.075);
  });

  it('treats 0 and 10000 as the closed interval bounds', () => {
    expect(basisPointsToRate(0)).toBe(0);
    expect(basisPointsToRate(10_000)).toBe(1);
  });
});
