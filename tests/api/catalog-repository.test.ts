/**
 * The row mapper is the regression test for a bug that shipped in this file.
 *
 * `query` returns PostgreSQL's column names, so a `SELECT price_minor` arrives
 * as `price_minor`, not `priceMinor`. The original repository cast
 * `rows as CatalogProduct[]` instead of renaming the fields, which typechecked
 * perfectly and then returned `undefined` for every money and stock field --
 * the browse page showed products with no price, and `inStock` was falsy for
 * every product, including the unlimited-stock ones. The cast was the bug: it
 * told the compiler a rename had happened when it had not.
 *
 * These tests therefore assert on *values*, not on types. `expect(p.priceMinor)
 * .toBeTypeOf('number')` would pass against the broken version if the seed ever
 * produced nulls; `expect(p.priceMinor).toBe(priceFromTheDatabase)` cannot.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { getProductBySlug, listCatalogProducts, listCategories } from '@/server/repositories/catalog';
import { query } from '@/server/db/client';

describe('catalog repository', () => {
  let slug: string;
  let expectedPriceMinor: number;
  let expectedCurrencyCode: string;
  let expectedExponent: number;
  let expectedStockPolicy: string;

  beforeAll(async () => {
    const { rows } = await query<{
      slug: string;
      price_minor: number;
      currency_code: string;
      exponent: number;
      stock_policy: string;
    }>(
      `SELECT p.slug, p.price_minor, p.currency_code, c.exponent, p.stock_policy
         FROM products p
         JOIN currencies c ON c.code = p.currency_code
         JOIN seller_profiles sp ON sp.user_id = p.seller_id
        WHERE p.status = 'active' AND sp.status = 'active'
        ORDER BY p.created_at DESC, p.id
        LIMIT 1`
    );
    const row = rows[0];
    if (!row) throw new Error('seed produced no active products');
    slug = row.slug;
    expectedPriceMinor = row.price_minor;
    expectedCurrencyCode = row.currency_code;
    expectedExponent = row.exponent;
    expectedStockPolicy = row.stock_policy;
  });

  it('maps every snake_case column onto its camelCase field', async () => {
    const product = await getProductBySlug(slug);

    expect(product).not.toBeNull();
    // The assertion that fails against the old `rows as CatalogProduct[]` cast.
    expect(product!.priceMinor).toBe(expectedPriceMinor);
    expect(product!.currencyCode).toBe(expectedCurrencyCode);
    expect(product!.currencyExponent).toBe(expectedExponent);
    expect(product!.stockPolicy).toBe(expectedStockPolicy);
    expect(product!.taxRateBp).toBeTypeOf('number');
    expect(product!.ratingAverageBp).toBeTypeOf('number');
    expect(product!.ratingCount).toBeTypeOf('number');
    expect(product!.shopName).toBeTypeOf('string');
    expect(product!.shopSlug).toBeTypeOf('string');
  });

  it('carries no snake_case keys on the mapped object', async () => {
    const product = await getProductBySlug(slug);
    const keys = Object.keys(product!);
    expect(keys.filter((k) => k.includes('_'))).toEqual([]);
  });

  it('derives inStock so unlimited stock is never reported as sold out', async () => {
    const page = await listCatalogProducts({ limit: 50, offset: 0 });
    expect(page.products.length).toBeGreaterThan(0);

    for (const product of page.products) {
      const expected = product.stockPolicy === 'unlimited' || (product.stockQuantity ?? 0) > 0;
      expect(product.inStock).toBe(expected);
    }
  });

  it('has a stockQuantity for tracked stock and null for unlimited', async () => {
    const page = await listCatalogProducts({ limit: 50, offset: 0 });
    for (const product of page.products) {
      if (product.stockPolicy === 'unlimited') {
        expect(product.stockQuantity).toBeNull();
      } else {
        expect(product.stockQuantity).toBeTypeOf('number');
      }
    }
  });

  it('returns a total that agrees with the rows, not just with the page', async () => {
    // `total` comes from a separate count(*) over the same predicate. If the
    // two ever disagree, the browse screen shows "24 results" over 12 cards.
    const first = await listCatalogProducts({ limit: 3, offset: 0 });
    const all = await listCatalogProducts({ limit: 50, offset: 0 });

    expect(first.total).toBe(all.products.length);
    expect(first.products).toHaveLength(Math.min(3, first.total));
  });

  it('paginates without repeating or dropping rows', async () => {
    const everything = await listCatalogProducts({ limit: 50, offset: 0 });
    const firstPage = await listCatalogProducts({ limit: 2, offset: 0 });
    const secondPage = await listCatalogProducts({ limit: 2, offset: 2 });

    expect(firstPage.products.map((p) => p.id)).toEqual(
      everything.products.slice(0, 2).map((p) => p.id)
    );
    expect(secondPage.products.map((p) => p.id)).toEqual(
      everything.products.slice(2, 4).map((p) => p.id)
    );
  });

  it('filters by category without changing the meaning of total', async () => {
    const page = await listCatalogProducts({ limit: 50, offset: 0, category: 'spices' });
    expect(page.products.length).toBeGreaterThan(0);
    expect(page.products.every((p) => p.category === 'spices')).toBe(true);
    expect(page.total).toBe(page.products.length);
  });

  it('returns null for a slug that does not exist', async () => {
    expect(await getProductBySlug('no-such-product-404')).toBeNull();
  });

  it('maps category facet counts off the snake_case alias', async () => {
    const categories = await listCategories();
    expect(categories.length).toBeGreaterThan(0);
    for (const c of categories) {
      expect(c.productCount).toBeTypeOf('number');
      expect(c.productCount).toBeGreaterThan(0);
    }
    // Sorted, so the filter row does not reshuffle between renders.
    expect([...categories].sort((a, b) => a.category.localeCompare(b.category))).toEqual(
      categories
    );
  });
});
