/**
 * Route-level contract tests.
 *
 * These call the exported `GET` directly rather than booting a server. That
 * loses exactly one thing -- real HTTP framing -- and buys the ability to assert
 * the response envelope and status code without a listening socket or a port to
 * collide on. The envelope and the status code are the contract; the socket is
 * not.
 */
import { describe, expect, it } from 'vitest';
import { GET as listProducts } from '@/app/api/v1/products/route';
import { GET as readHealth } from '@/app/api/v1/health/route';

function get(url: string): Request {
  return new Request(`http://localhost:4321${url}`);
}

describe('GET /api/v1/products', () => {
  it('returns an enveloped page with a total that matches the data length', async () => {
    const response = await listProducts(get('/api/v1/products?limit=60'));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: Array<Record<string, unknown>>;
      meta: { total: number; limit: number; offset: number };
    };

    expect(body.data.length).toBeGreaterThan(0);
    expect(body.meta).toMatchObject({ limit: 60, offset: 0 });
    // With limit 60 the whole seeded catalogue fits, so total and data must
    // agree. This is the assertion that catches a `total` counted with a
    // different predicate than the page.
    expect(body.meta.total).toBe(body.data.length);
  });

  it('serialises money as a minor-unit integer plus an exponent, never a float', async () => {
    const response = await listProducts(get('/api/v1/products?limit=1'));
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    const product = body.data[0]!;

    expect(Number.isInteger(product['priceMinor'])).toBe(true);
    expect(product['priceMinor']).not.toBeNull();
    expect(Number.isInteger(product['currencyExponent'])).toBe(true);
    // The key must be camelCase on the wire. A client that receives
    // `price_minor` is reading a database row, not an API resource.
    expect(product).not.toHaveProperty('price_minor');
    expect(product).not.toHaveProperty('currency_code');
  });

  it('applies its default limit when none is given', async () => {
    const response = await listProducts(get('/api/v1/products'));
    const body = (await response.json()) as { meta: { limit: number; offset: number } };
    expect(body.meta).toMatchObject({ limit: 24, offset: 0 });
  });

  it('rejects an out-of-range limit with 400 invalid_pagination', async () => {
    const response = await listProducts(get('/api/v1/products?limit=5000'));
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('invalid_pagination');
  });

  it('rejects a non-integer offset with 400 rather than silently coercing', async () => {
    const response = await listProducts(get('/api/v1/products?offset=1.5'));
    expect(response.status).toBe(400);
  });

  it('filters by category without 500-ing', async () => {
    // Regression test. The count query reused the page's placeholder numbers
    // while being handed the page's parameter array sliced, so any filter made
    // the count refer to $3 while supplying one argument. PostgreSQL rejected it
    // with "could not determine data type of parameter $1" and the route
    // answered 500. Unfiltered browsing still worked, so the search box and the
    // filter row were the only broken paths -- exactly the ones a smoke test on
    // a clean database never touches.
    const response = await listProducts(get('/api/v1/products?category=spices'));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: Array<{ category: string }>;
      meta: { total: number };
    };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((p) => p.category === 'spices')).toBe(true);
    expect(body.meta.total).toBe(body.data.length);
  });

  it('filters by free-text search using the indexed tsvector', async () => {
    const response = await listProducts(get('/api/v1/products?q=leather'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[]; meta: { total: number } };
    expect(body.meta.total).toBe(body.data.length);
  });

  it('filters by seller slug without 500-ing', async () => {
    const response = await listProducts(get('/api/v1/products?seller=lagos-leatherworks'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[]; meta: { total: number } };
    expect(body.meta.total).toBe(body.data.length);
  });

  it('returns an empty page rather than a 404 when the filter matches nothing', async () => {
    const response = await listProducts(get('/api/v1/products?category=no-such-category-xyz'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[]; meta: { total: number } };
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  it('is not cached: catalogue reads are marked dynamic', async () => {
    // The route declares `export const dynamic = 'force-dynamic'`. Asserting it
    // keeps a future edit from silently making the browse screen a build-time
    // snapshot of whatever products existed at deploy.
    const route = await import('@/app/api/v1/products/route');
    expect(route.dynamic).toBe('force-dynamic');
  });
});

describe('GET /api/v1/health', () => {
  it('reports healthy by counting the applied migrations', async () => {
    // Regression test: the route counted rows in `_migrations`, a table this
    // project never created, and the resulting error was caught by a bare
    // `catch` and reported as "database unavailable" -- against a database
    // serving traffic perfectly well. The real table is `schema_migrations`.
    // The route returns a flat body rather than the {data,meta} envelope, so
    // this asserts the flat shape on purpose.
    const response = await readHealth();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      database: string;
      latencyMs: number;
      migrated: number;
      products: number;
      orders: number;
    };
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
    expect(body.migrated).toBeGreaterThan(0);
    expect(body.products).toBeGreaterThan(0);
    expect(body.orders).toBeGreaterThan(0);
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
