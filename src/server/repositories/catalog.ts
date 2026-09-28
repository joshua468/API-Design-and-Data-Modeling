/**
 * Catalog reads.
 *
 * Workflow 1: a buyer browses products.
 *
 * Repository functions are the only place raw rows become typed objects. Routes
 * and pages call these; they never touch `query` directly, so the shape of a
 * row is pinned in exactly one file and a column rename fails the compiler here
 * rather than as `undefined` somewhere in a component.
 *
 * That promise is only kept by actually doing the rename. `query` returns rows
 * with whatever column names the SQL used, and PostgreSQL folds them to
 * `price_minor`, not `priceMinor`. Asserting `rows as CatalogProduct[]` would
 * typecheck and then hand every caller `undefined` for every money field --
 * a lie the compiler cannot catch, because the assertion *is* the cast. So each
 * row is mapped field by field below. The failure mode this buys: renaming
 * `price_minor` in the SELECT is now a TypeScript error at the mapper, not a
 * `formatMoney(undefined)` three layers away.
 */
import { query, type SqlParam } from '@/server/db/client';

export interface CatalogProduct {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string;
  readonly priceMinor: number;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly taxRateBp: number;
  readonly stockPolicy: 'tracked' | 'unlimited';
  readonly stockQuantity: number | null;
  readonly inStock: boolean;
  readonly shopName: string;
  readonly shopSlug: string;
  readonly ratingAverageBp: number;
  readonly ratingCount: number;
}

export interface CatalogPage {
  readonly products: readonly CatalogProduct[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface CatalogFilters {
  readonly limit: number;
  readonly offset: number;
  readonly category?: string;
  readonly sellerSlug?: string;
  /** Case-insensitive substring over name and description. */
  readonly search?: string;
}

/** One row exactly as PostgreSQL returns it, before renaming. */
interface CatalogProductRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string;
  readonly price_minor: number;
  readonly currency_code: string;
  readonly currency_exponent: number;
  readonly tax_rate_bp: number;
  readonly stock_policy: string;
  readonly stock_quantity: number | null;
  readonly in_stock: boolean;
  readonly shop_name: string;
  readonly shop_slug: string;
  readonly rating_average_bp: number;
  readonly rating_count: number;
}

function toProduct(row: CatalogProductRow): CatalogProduct {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    priceMinor: row.price_minor,
    currencyCode: row.currency_code,
    currencyExponent: row.currency_exponent,
    taxRateBp: row.tax_rate_bp,
    stockPolicy: row.stock_policy as CatalogProduct['stockPolicy'],
    stockQuantity: row.stock_quantity,
    inStock: row.in_stock,
    shopName: row.shop_name,
    shopSlug: row.shop_slug,
    ratingAverageBp: row.rating_average_bp,
    ratingCount: row.rating_count,
  };
}


/**
 * One row per product, joined to its shop and the shop's rating aggregate.
 *
 * Two deliberate choices:
 *
 *  - `currencies` is joined rather than assuming 2 decimals, so the exponent
 *    travels with the row and `formatMoney` never guesses.
 *  - A seller whose profile is not `active` is filtered out in the same
 *    statement. Doing it here rather than in application code means the count
 *    and the page agree -- filtering after a LIMIT would make `total` a lie.
 */
const CATALOG_SELECT = `
  SELECT p.id,
         p.slug,
         p.name,
         p.description,
         p.category,
         p.price_minor,
         p.currency_code,
         c.exponent            AS currency_exponent,
         p.tax_rate_bp,
         p.stock_policy,
         p.stock_quantity,
         (p.stock_policy = 'unlimited' OR p.stock_quantity > 0) AS in_stock,
         sp.shop_name,
         sp.slug                AS shop_slug,
         sp.rating_average_bp,
         sp.rating_count
    FROM products p
    JOIN seller_profiles sp ON sp.user_id = p.seller_id
    JOIN currencies c      ON c.code = p.currency_code
`;

const CATALOG_PREDICATE = `
  WHERE p.status = 'active'
    AND sp.status = 'active'
`;

/**
 * Builds the optional filter clauses for one statement, numbering its
 * placeholders from `startAt`.
 *
 * The `startAt` argument is load-bearing and it exists because of a bug. The
 * catalogue is loaded as two statements -- the page and its `count(*)` -- and
 * the count takes no LIMIT/OFFSET, so it has fewer placeholders before the
 * filters begin. Both statements used to be handed the same clause list and the
 * same parameter array, sliced: the count received `$1` while its SQL still
 * referred to `$3`. Every filtered request then died with
 *
 *     could not determine data type of parameter $1
 *
 * and the route turned it into a 500. Unfiltered browsing still worked, because
 * with no filters the slice happened to leave the numbering consistent -- which
 * is why it survived: the only thing broken was the search box and the filter
 * row, the two things nobody smoke-tests on a clean database.
 *
 * Numbering each statement from its own start is the fix. The alternative,
 * `replace(/\$\d+/g, ...)` on the rendered SQL, renumbers correctly by accident
 * and breaks the moment a regex is wrong.
 */
function buildFilterClauses(filters: CatalogFilters, startAt: number): {
  clauses: string[];
  params: SqlParam[];
} {
  const params: SqlParam[] = [];
  const clauses: string[] = [];

  if (filters.category !== undefined) {
    const idx = startAt + params.length;
    params.push(filters.category);
    clauses.push(`AND p.category = $${idx}`);
  }
  if (filters.sellerSlug !== undefined) {
    const idx = startAt + params.length;
    params.push(filters.sellerSlug);
    clauses.push(`AND sp.slug = $${idx}`);
  }
  if (filters.search !== undefined) {
    // The GIN index is on `search_document`, so this is an indexed containment
    // match rather than a `LIKE '%...%'` that would force a sequential scan.
    const idx = startAt + params.length;
    params.push(filters.search);
    clauses.push(
      `AND p.search_document @@ plainto_tsquery('english', $${idx})`
    );
  }

  return { clauses, params };
}

export async function listCatalogProducts(filters: CatalogFilters): Promise<CatalogPage> {
  const page = buildFilterClauses(filters, 3);
  const count = buildFilterClauses(filters, 1);

  const where = (r: { clauses: string[] }): string =>
    [CATALOG_PREDICATE, ...r.clauses].join('\n    ');

  // These two are issued one after the other, and that is not a style choice.
  //
  // They were originally `Promise.all`, on the reasonable assumption that two
  // reads on one connection overlap. PGlite is a single embedded connection, so
  // they do not: both go through the extended protocol, and interleaving two
  // Parse/Bind/Execute sequences on one connection cross-binds the parameters.
  // The page's three placeholders got bound against the count's one argument and
  // PostgreSQL rejected the result with 42P18, "could not determine data type of
  // parameter $1" -- a 500 on every filtered browse.
  //
  // It only reproduced once both statements were parameterized. Unfiltered
  // browsing sent the count with zero parameters, which takes the simple query
  // protocol, so nothing interleaved and the bug stayed invisible. A concurrency
  // bug that only fires when a filter is applied is exactly the kind that ships.
  const rows = await query<CatalogProductRow>(
    `${CATALOG_SELECT}
     ${where(page)}
     ORDER BY p.created_at DESC, p.id
     LIMIT $1 OFFSET $2`,
    [filters.limit, filters.offset, ...page.params]
  );

  // Same predicate, same joins, independently numbered. `total` therefore
  // cannot disagree with the page: they are the same question, asked twice.
  const counted = await query<{ total: number }>(
    `SELECT count(*)::bigint AS total
       FROM products p
       JOIN seller_profiles sp ON sp.user_id = p.seller_id
       JOIN currencies c      ON c.code = p.currency_code
     ${where(count)}`,
    count.params
  );

  return {
    products: rows.rows.map(toProduct),
    total: counted.rows[0]?.total ?? 0,
    limit: filters.limit,
    offset: filters.offset,
  };
}

export interface CatalogCategory {
  readonly category: string;
  readonly productCount: number;
}

/** Facet counts for the browse screen's filter row. */
export async function listCategories(): Promise<readonly CatalogCategory[]> {
  const { rows } = await query<{ category: string; product_count: number }>(
    `SELECT p.category, count(*)::bigint AS product_count
       FROM products p
       JOIN seller_profiles sp ON sp.user_id = p.seller_id
      WHERE p.status = 'active' AND sp.status = 'active'
      GROUP BY p.category
      ORDER BY p.category`
  );
  return rows.map((r) => ({ category: r.category, productCount: r.product_count }));
}

export async function getProductBySlug(slug: string): Promise<CatalogProduct | null> {
  const { rows } = await query<CatalogProductRow>(
    `${CATALOG_SELECT}
     ${CATALOG_PREDICATE}
       AND p.slug = $1
     LIMIT 1`,
    [slug]
  );
  return rows[0] === undefined ? null : toProduct(rows[0]);
}
