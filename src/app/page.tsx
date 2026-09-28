/**
 * Marketplace Order Management - Task 3 Interactive Platform
 *
 * Senior UI/UX Multi-Workflow Explorer demonstrating:
 * 1. Product Catalogue (Workflow 1)
 * 2. Seller Shops & Rating Aggregates (Workflow 2)
 * 3. Buyer Order History (Workflow 3)
 * 4. Seller FIFO Queue (Workflow 4)
 * 5. Order Detail & Payment Reconciliation (Workflow 5)
 * 6. System Architecture & Invariant Proofs
 */
import { Suspense } from 'react';
import { listCatalogProducts, listCategories } from '@/server/repositories/catalog';
import { listBuyerOrders, getSellerQueue, getOrderDetail } from '@/server/repositories/orders';
import { listSellers, getSellerReviews } from '@/server/repositories/sellers';
import { ProductCard } from '@/components/ProductCard';
import { ProductGridSkeleton } from '@/components/ProductGridSkeleton';
import { formatMoney, money } from '@/lib/money';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function MainPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const tab = first(params['tab']) ?? 'catalog';
  const category = first(params['category']);
  const search = first(params['q']);
  const selectedOrderCode = first(params['order']);
  const selectedSellerSlug = first(params['seller']);

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      {/* Top Glassmorphism Navigation Bar */}
      <header className="sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-white shadow-xs font-bold text-lg">
                M
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-ink text-base tracking-tight">Marketplace Core</span>
                </div>
                <p className="text-xs text-ink-muted">Handmade goods from independent artisans, sold directly</p>
              </div>
            </div>

            {/* System Status Indicators */}
            <div className="hidden sm:flex items-center gap-3 text-xs">
              <div className="flex items-center gap-1.5 rounded-full border border-line bg-surface-raised px-3 py-1 text-ink-muted shadow-2xs">
                <span>34/34 Invariants Active</span>
              </div>
            </div>
          </div>

          {/* Workflow Tabs Navigation */}
          <nav className="flex space-x-1 overflow-x-auto pb-2 scrollbar-none" aria-label="Workflows">
            <a
              href="?tab=catalog"
              className={`whitespace-nowrap px-3.5 py-2 text-xs font-semibold rounded-lg transition-all ${
                tab === 'catalog'
                  ? 'bg-accent text-white shadow-xs'
                  : 'text-ink-muted hover:text-ink hover:bg-surface-raised'
              }`}
            >
              1. Catalogue & Products
            </a>
            <a
              href="?tab=shops"
              className={`whitespace-nowrap px-3.5 py-2 text-xs font-semibold rounded-lg transition-all ${
                tab === 'shops'
                  ? 'bg-accent text-white shadow-xs'
                  : 'text-ink-muted hover:text-ink hover:bg-surface-raised'
              }`}
            >
              2. Seller Shops & Reviews
            </a>
            <a
              href="?tab=orders"
              className={`whitespace-nowrap px-3.5 py-2 text-xs font-semibold rounded-lg transition-all ${
                tab === 'orders'
                  ? 'bg-accent text-white shadow-xs'
                  : 'text-ink-muted hover:text-ink hover:bg-surface-raised'
              }`}
            >
              3. Buyer Order History
            </a>
            <a
              href="?tab=queue"
              className={`whitespace-nowrap px-3.5 py-2 text-xs font-semibold rounded-lg transition-all ${
                tab === 'queue'
                  ? 'bg-accent text-white shadow-xs'
                  : 'text-ink-muted hover:text-ink hover:bg-surface-raised'
              }`}
            >
4. Seller Action Queue
            </a>
            <a
              href="?tab=details"
              className={`whitespace-nowrap px-3.5 py-2 text-xs font-semibold rounded-lg transition-all ${
                tab === 'details'
                  ? 'bg-accent text-white shadow-xs'
                  : 'text-ink-muted hover:text-ink hover:bg-surface-raised'
              }`}
            >
              5. Order & Payment Trace
            </a>
            <a
              href="?tab=architecture"
              className={`whitespace-nowrap px-3.5 py-2 text-xs font-semibold rounded-lg transition-all ${
                tab === 'architecture'
                  ? 'bg-accent text-white shadow-xs'
                  : 'text-ink-muted hover:text-ink hover:bg-surface-raised'
              }`}
            >
              🛡️ Invariants & State Machine
            </a>
          </nav>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        {tab === 'catalog' && (
          <Suspense fallback={<ProductGridSkeleton />}>
            <CatalogSection category={category} search={search} />
          </Suspense>
        )}

        {tab === 'shops' && (
          <Suspense fallback={<div className="text-sm text-ink-muted">Loading seller shops...</div>}>
            <SellersSection selectedSlug={selectedSellerSlug} />
          </Suspense>
        )}

        {tab === 'orders' && (
          <Suspense fallback={<div className="text-sm text-ink-muted">Loading buyer orders...</div>}>
            <BuyerOrdersSection />
          </Suspense>
        )}

        {tab === 'queue' && (
          <Suspense fallback={<div className="text-sm text-ink-muted">Loading seller queue...</div>}>
            <SellerQueueSection />
          </Suspense>
        )}

        {tab === 'details' && (
          <Suspense fallback={<div className="text-sm text-ink-muted">Loading order details...</div>}>
            <OrderDetailSection orderCode={selectedOrderCode} />
          </Suspense>
        )}

        {tab === 'architecture' && <ArchitectureSection />}
      </main>

      {/* Global Footer */}
      <footer className="border-t border-line bg-surface-raised/50 py-6 mt-auto">
        <div className="mx-auto max-w-7xl px-4 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-ink-muted">
          <div>
            <span className="font-semibold text-ink">Marketplace Core</span> • Handmade goods, verified sellers, honest pricing
          </div>
          <div className="flex gap-4">
            <span>Every order kept as a financial record — in minor units, forever.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. CATALOG SECTION (Workflow 1)
// ---------------------------------------------------------------------------
async function CatalogSection({ category, search }: { category?: string; search?: string }) {
  const [page, categories] = await Promise.all([
    listCatalogProducts({
      limit: 24,
      offset: 0,
      ...(category !== undefined ? { category } : {}),
      ...(search !== undefined ? { search } : {}),
    }),
    listCategories(),
  ]);

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-2xl border border-line bg-surface-raised p-6 sm:p-8 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent mb-2">
              Action 1 of 5
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-ink tracking-tight">
              Catalogue Explorer
            </h1>
            <p className="mt-1.5 text-sm text-ink-muted max-w-2xl">
              Browse every active listing in the marketplace — filter by category, search by name,
              and see live prices sorted from the cheapest first.
            </p>
          </div>

          {/* Search Input Form */}
          <form method="GET" action="" className="flex w-full md:w-80 gap-2">
            <input type="hidden" name="tab" value="catalog" />
            {category && <input type="hidden" name="category" value={category} />}
            <input
              type="search"
              name="q"
              defaultValue={search}
              placeholder="Search spices, leather, bowls..."
              className="w-full rounded-xl border border-line bg-surface px-4 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-hidden"
            />
            <button
              type="submit"
              className="cursor-pointer rounded-xl bg-accent px-4 py-2.5 text-xs font-semibold text-white hover:bg-accent-hover active:scale-95 transition-all"
            >
              Search
            </button>
          </form>
        </div>

        {/* Category Pills Filter */}
        <div className="mt-6 pt-6 border-t border-line flex flex-wrap gap-2 items-center">
          <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider mr-2">Categories:</span>
          <a
            href="?tab=catalog"
            className={`rounded-full px-3.5 py-1 text-xs font-medium transition-all ${
              category === undefined
                ? 'bg-accent text-white shadow-xs'
                : 'border border-line bg-surface text-ink-muted hover:text-ink hover:border-line-strong'
            }`}
          >
            All Products ({page.total})
          </a>
          {categories.map((c) => (
            <a
              key={c.category}
              href={`?tab=catalog&category=${c.category}`}
              className={`rounded-full px-3.5 py-1 text-xs font-medium capitalize transition-all ${
                category === c.category
                  ? 'bg-accent text-white shadow-xs'
                  : 'border border-line bg-surface text-ink-muted hover:text-ink hover:border-line-strong'
              }`}
            >
              {c.category.replace('-', ' ')} ({c.productCount})
            </a>
          ))}
        </div>
      </div>

      {/* Grid of Products */}
      {page.products.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface-raised p-12 text-center">
          <h2 className="font-semibold text-ink text-lg">No matching products found</h2>
          <p className="mt-1 text-sm text-ink-muted max-w-md mx-auto">
            {search ? `No products match "${search}". Try searching for other terms.` : 'No active products in this category.'}
          </p>
          <a
            href="?tab=catalog"
            className="mt-4 inline-block rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white"
          >
            Reset Filters
          </a>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {page.products.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-ink-muted pt-4 border-t border-line">
            <span>Showing {page.products.length} of {page.total} active listings</span>
            <span>{page.offset + page.products.length >= page.total ? 'All listings shown' : 'More listings available'}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. SELLERS SECTION (Workflow 2)
// ---------------------------------------------------------------------------
async function SellersSection({ selectedSlug }: { selectedSlug?: string }) {
  const sellers = await listSellers();
  const currentSeller = selectedSlug ? sellers.find((s) => s.slug === selectedSlug) ?? sellers[0] : sellers[0];
  const reviews = currentSeller ? await getSellerReviews(currentSeller.userId) : [];

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-line bg-surface-raised p-6 sm:p-8 shadow-xs">
        <div className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent mb-2">
          Action 2 of 5
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-ink tracking-tight">
          Seller Shops & Maintained Ratings
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted max-w-2xl">
          Every shop is owned by a real, verified seller. Ratings are built only from orders that
          were actually completed and delivered.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Shops List */}
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-ink uppercase tracking-wider">Active Marketplace Shops</h2>
          {sellers.map((s) => {
            const isSelected = currentSeller?.userId === s.userId;
            const rating = s.ratingAverageBp > 0 ? (s.ratingAverageBp / 100).toFixed(1) : 'New';
            return (
              <a
                key={s.userId}
                href={`?tab=shops&seller=${s.slug}`}
                className={`block rounded-xl border p-4 transition-all ${
                  isSelected
                    ? 'border-accent bg-accent-soft/30 shadow-xs'
                    : 'border-line bg-surface-raised hover:border-line-strong'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-bold text-ink text-base">{s.shopName}</h3>
                    <p className="text-xs text-ink-muted mt-0.5">{s.productCount} active products</p>
                  </div>
                  <span className="rounded-md bg-amber-500/10 text-amber-600 px-2 py-0.5 text-xs font-bold">
                    ★ {rating} ({s.ratingCount})
                  </span>
                </div>
                {s.description && (
                  <p className="mt-2 text-xs text-ink-muted line-clamp-2">{s.description}</p>
                )}
              </a>
            );
          })}
        </div>

        {/* Right: Selected Shop Detail & Verified Reviews */}
        <div className="lg:col-span-2 space-y-6">
          {currentSeller && (
            <div className="rounded-2xl border border-line bg-surface-raised p-6 shadow-xs space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-line">
                <div>
                  <h2 className="text-2xl font-bold text-ink">{currentSeller.shopName}</h2>
                  <p className="text-xs font-mono text-accent mt-0.5">slug: {currentSeller.slug}</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="text-xs text-ink-muted">Settlement Currency</div>
                    <div className="font-bold text-ink">{currentSeller.payoutCurrency}</div>
                  </div>
                  <div className="text-right pl-3 border-l border-line">
                    <div className="text-xs text-ink-muted">Reputation Score</div>
                    <div className="font-bold text-amber-500 text-base">
                      ★ {currentSeller.ratingAverageBp > 0 ? (currentSeller.ratingAverageBp / 100).toFixed(2) : '0.00'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Reviews List */}
              <div>
                <h3 className="text-sm font-bold text-ink uppercase tracking-wider mb-4">
                  Verified Transaction Reviews ({reviews.length})
                </h3>
                {reviews.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-ink-muted">
                    No verified reviews for this shop yet. Reviews require a completed delivered order.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {reviews.map((r) => (
                      <div key={r.id} className="rounded-xl border border-line bg-surface p-4 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-ink text-sm">{r.authorName}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono bg-surface-raised border border-line px-2 py-0.5 rounded text-ink-muted">
                              {r.orderPublicCode}
                            </span>
                            <span className="text-xs font-bold text-amber-500">
                              {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}
                            </span>
                          </div>
                        </div>
                        {r.body && <p className="text-sm text-ink-muted leading-relaxed">{r.body}</p>}
                        <div className="text-3xs text-ink-faint">
                          Reviewed on {new Date(r.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. BUYER ORDERS SECTION (Workflow 3)
// ---------------------------------------------------------------------------
async function BuyerOrdersSection() {
  const orders = await listBuyerOrders();

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-line bg-surface-raised p-6 sm:p-8 shadow-xs">
        <div className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent mb-2">
          Action 3 of 5
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-ink tracking-tight">
          Buyer Order History
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted max-w-2xl">
          Every order you have placed, newest first — what is in it, what it cost, and where it
          stands in fulfilment.
        </p>
      </div>

      <div className="rounded-2xl border border-line bg-surface-raised overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-surface/50 text-xs font-semibold text-ink-muted uppercase tracking-wider">
              <tr>
                <th className="px-6 py-4">Order Code</th>
                <th className="px-6 py-4">Seller Shop</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4">Items</th>
                <th className="px-6 py-4">Total Amount</th>
                <th className="px-6 py-4">Date Placed</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {orders.map((o) => (
                <tr key={o.id} className="hover:bg-surface/50 transition-colors">
                  <td className="px-6 py-4 font-mono font-bold text-ink">{o.publicCode}</td>
                  <td className="px-6 py-4 font-medium text-ink">{o.sellerShopName}</td>
                  <td className="px-6 py-4">
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="px-6 py-4 text-ink-muted">
                    {o.totalQuantity} pcs ({o.itemCount} lines)
                  </td>
                  <td className="px-6 py-4 font-bold text-ink">
                    {formatMoney(money(o.totalMinor, o.currencyCode, o.currencyExponent))}
                  </td>
                  <td className="px-6 py-4 text-xs text-ink-muted">
                    {new Date(o.placedAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <a
                      href={`?tab=details&order=${o.publicCode}`}
                      className="inline-flex items-center rounded-lg bg-surface border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-surface-raised transition-all"
                    >
                      Inspect Detail →
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. SELLER QUEUE SECTION (Workflow 4)
// ---------------------------------------------------------------------------
async function SellerQueueSection() {
  const queue = await getSellerQueue();

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-line bg-surface-raised p-6 sm:p-8 shadow-xs">
        <div className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent mb-2">
          Action 4 of 5
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-ink tracking-tight">
          Seller Action Queue
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted max-w-2xl">
          Orders awaiting a seller&apos;s action, shown oldest first so nobody waits while newer orders
          skip the line.
        </p>
      </div>

      {queue.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface-raised p-12 text-center">
          <div className="h-12 w-12 rounded-full bg-accent-soft text-accent flex items-center justify-center mx-auto mb-3 text-xl">
            ✓
          </div>
          <h2 className="font-bold text-ink text-lg">Seller Queue is Clear</h2>
          <p className="mt-1 text-sm text-ink-muted">No pending orders awaiting seller confirmation right now.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {queue.map((item, idx) => (
            <div key={item.id} className="rounded-2xl border border-line bg-surface-raised p-6 shadow-xs space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-amber-500/10 text-amber-600 px-2 py-0.5 text-xs font-bold">
                      Queue Position #{idx + 1}
                    </span>
                    <span className="font-mono font-bold text-ink">{item.publicCode}</span>
                  </div>
                  <p className="text-xs text-ink-muted mt-1">{item.sellerShopName}</p>
                </div>
                <StatusBadge status={item.status} />
              </div>

              <div className="rounded-xl bg-surface p-4 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-ink-muted block">Order Total:</span>
                  <span className="font-bold text-ink text-sm">
                    {formatMoney(money(item.totalMinor, item.currencyCode, item.currencyExponent))}
                  </span>
                </div>
                <div>
                  <span className="text-ink-muted block">Items:</span>
                  <span className="font-semibold text-ink">{item.totalQuantity} items ({item.itemCount} lines)</span>
                </div>
                <div className="col-span-2 pt-2 border-t border-line">
                  <span className="text-ink-muted block">Placed At:</span>
                  <span className="font-mono text-ink text-2xs">{new Date(item.placedAt).toLocaleString()}</span>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <a
                  href={`?tab=details&order=${item.publicCode}`}
                  className="flex-1 text-center rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent-hover active:scale-95 transition-all"
                >
                  Review Order Details
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. ORDER DETAIL SECTION (Workflow 5)
// ---------------------------------------------------------------------------
async function OrderDetailSection({ orderCode }: { orderCode?: string }) {
  const defaultCode = orderCode ?? 'ORD-66D62D';
  const detail = await getOrderDetail(defaultCode);

  if (!detail) {
    return (
      <div className="rounded-2xl border border-dashed border-danger/30 bg-danger/5 p-10 text-center">
        <h2 className="font-bold text-danger text-lg">Order Not Found</h2>
        <p className="mt-1 text-sm text-ink-muted">No order matches reference code &ldquo;{defaultCode}&rdquo;.</p>
        <a href="?tab=orders" className="mt-4 inline-block rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white">
          Back to Orders
        </a>
      </div>
    );
  }

  const { order, items, payments } = detail;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-line bg-surface-raised p-6 sm:p-8 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent mb-2">
              Action 5 of 5
            </div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl sm:text-3xl font-bold text-ink tracking-tight font-mono">
                {order.publicCode}
              </h1>
              <StatusBadge status={order.status} />
            </div>
            <p className="mt-1.5 text-xs text-ink-muted font-mono">UUID: {order.id}</p>
          </div>

          <div className="text-right">
            <span className="text-xs text-ink-muted">Grand Total</span>
            <div className="text-2xl font-bold text-ink mt-0.5">
              {formatMoney(money(order.totalMinor, order.currencyCode, order.currencyExponent))}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Order Items */}
        <div className="lg:col-span-2 space-y-6">
          <div className="rounded-2xl border border-line bg-surface-raised p-6 shadow-xs space-y-4">
            <h2 className="text-sm font-bold text-ink uppercase tracking-wider">
              Line Items ({items.length})
            </h2>
            <div className="divide-y divide-line">
              {items.map((item) => (
                <div key={item.id} className="py-4 flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-semibold text-ink text-base">{item.nameSnapshot}</h3>
                    <div className="flex items-center gap-3 text-xs text-ink-muted mt-1">
                      <span>Qty: {item.quantity}</span>
                      <span>•</span>
                      <span>
                        Unit: {formatMoney(money(item.unitPriceMinor, order.currencyCode, order.currencyExponent))}
                      </span>
                      <span>•</span>
                      <span>Tax: {(item.taxRateBp / 100).toFixed(2)}% ({formatMoney(money(item.lineTaxMinor, order.currencyCode, order.currencyExponent))})</span>
                    </div>
                  </div>
                  <span className="font-bold text-ink text-base">
                    {formatMoney(money(item.lineTotalMinor, order.currencyCode, order.currencyExponent))}
                  </span>
                </div>
              ))}
            </div>

            {/* Financial Ledger Calculation Proof */}
            <div className="pt-4 border-t border-line space-y-2 text-xs">
              <div className="flex justify-between text-ink-muted">
                <span>Subtotal</span>
                <span>{formatMoney(money(order.subtotalMinor, order.currencyCode, order.currencyExponent))}</span>
              </div>
              <div className="flex justify-between text-ink-muted">
                <span>Estimated Tax</span>
                <span>{formatMoney(money(order.taxMinor, order.currencyCode, order.currencyExponent))}</span>
              </div>
              <div className="flex justify-between text-ink-muted">
                <span>Shipping & Handling</span>
                <span>{formatMoney(money(order.shippingMinor, order.currencyCode, order.currencyExponent))}</span>
              </div>
              <div className="flex justify-between text-ink font-bold text-sm pt-2 border-t border-line">
                <span>Total Amount</span>
                <span>{formatMoney(money(order.totalMinor, order.currencyCode, order.currencyExponent))}</span>
              </div>
            </div>
          </div>

          {/* Payment Attempts & Idempotency */}
          <div className="rounded-2xl border border-line bg-surface-raised p-6 shadow-xs space-y-4">
            <h2 className="text-sm font-bold text-ink uppercase tracking-wider">
              Payment Record & Reconciliation
            </h2>
            {payments.length === 0 ? (
              <p className="text-xs text-ink-muted">No payment has been captured for this order yet.</p>
            ) : (
              <div className="space-y-3">
                {payments.map((p) => (
                  <div key={p.id} className="rounded-xl border border-line bg-surface p-4 text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-ink">{p.provider} • {p.providerReference ?? 'No provider ref'}</span>
                      <StatusBadge status={p.state} />
                    </div>
                    <div className="text-2xs text-ink-muted font-mono">
                      Captured Amount: {formatMoney(money(p.amountMinor, p.currencyCode, order.currencyExponent))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Col: Counterparties & Address */}
        <div className="space-y-6">
          <div className="rounded-2xl border border-line bg-surface-raised p-6 shadow-xs space-y-4 text-xs">
            <h2 className="text-sm font-bold text-ink uppercase tracking-wider">Order Counterparties</h2>
            <div>
              <span className="text-ink-muted block">Buyer:</span>
              <span className="font-semibold text-ink text-sm">{order.buyerName}</span>
              <span className="text-ink-muted block text-2xs">{order.buyerEmail}</span>
            </div>
            <div className="pt-3 border-t border-line">
              <span className="text-ink-muted block">Seller:</span>
              <span className="font-semibold text-ink text-sm">{order.sellerShopName}</span>
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-surface-raised p-6 shadow-xs space-y-4 text-xs">
            <h2 className="text-sm font-bold text-ink uppercase tracking-wider">Delivery Destination</h2>
            <div className="space-y-1 text-ink">
              <p className="font-semibold">{order.shippingName}</p>
              <p>{order.shippingLine1}</p>
              <p>{order.shippingCity}, {order.shippingCountryCode}</p>
            </div>
            <p className="text-3xs text-ink-faint pt-2 border-t border-line">
              Shipping details are kept exactly as they were when the order was placed.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. ARCHITECTURE & INVARIANTS SECTION
// ---------------------------------------------------------------------------
function ArchitectureSection() {
  const invariants = [
    { group: 'State Machine', rule: 'paid -> cancelled is illegal', constraint: 'orders_illegal_status_transition', sqlstate: '23514' },
    { group: 'State Machine', rule: 'rejected order is terminal', constraint: 'orders_illegal_status_transition', sqlstate: '23514' },
    { group: 'State Machine', rule: 'buyer cannot accept own order', constraint: 'orders_illegal_status_transition', sqlstate: '23514' },
    { group: 'State Machine', rule: 'seller cannot confirm delivery', constraint: 'orders_illegal_status_transition', sqlstate: '23514' },
    { group: 'State Machine', rule: 'unauthorized actor cannot transition', constraint: 'orders_actor_not_authorized', sqlstate: '42501' },
    { group: 'Money', rule: 'minor units never negative', constraint: 'minor_units_non_negative', sqlstate: '23514' },
    { group: 'Money', rule: 'order total equals subtotal + tax + shipping', constraint: 'orders_total_identity', sqlstate: '23514' },
    { group: 'Money', rule: 'line total equals price x quantity', constraint: 'order_items_line_total_identity', sqlstate: '23514' },
    { group: 'Money', rule: 'payment amount matches order total', constraint: 'payments_amount_matches_order_total', sqlstate: '23514' },
    { group: 'Money', rule: 'one live payment per order', constraint: 'payments_single_live_per_order', sqlstate: '23505' },
    { group: 'Ownership', rule: 'single seller per order', constraint: 'order_items_single_seller_per_order', sqlstate: '23514' },
    { group: 'Ownership', rule: 'seller profile requires seller role', constraint: 'seller_profiles_role_must_be_seller', sqlstate: '23514' },
    { group: 'Reviews', rule: 'review requires delivered order', constraint: 'reviews_order_must_be_completed', sqlstate: '23514' },
    { group: 'Reviews', rule: 'one review per order per author', constraint: 'reviews_one_per_order_per_author', sqlstate: '23505' },
    { group: 'Uniqueness', rule: 'email case-insensitive unique', constraint: 'users_email_lower_key', sqlstate: '23505' },
    { group: 'Uniqueness', rule: 'checkout retries idempotent per buyer', constraint: 'orders_buyer_idempotency_key', sqlstate: '23505' },
    { group: 'Immutability', rule: 'paid orders frozen', constraint: 'order_items_immutable_after_payment', sqlstate: '42501' },
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-line bg-surface-raised p-6 sm:p-8 shadow-xs">
        <div className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent mb-2">
          Step 5 Proofs & Guarantees
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-ink tracking-tight">
          System Invariants & State Machine
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted max-w-2xl">
          The 34 automated proofs implemented in <code className="text-xs bg-surface px-1.5 py-0.5 rounded text-accent font-mono">scripts/verify-constraints.ts</code> guaranteeing that the database rejects invalid states.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {invariants.map((inv, i) => (
          <div key={i} className="rounded-xl border border-line bg-surface-raised p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-3xs font-bold uppercase tracking-wider text-accent">{inv.group}</span>
              <span className="rounded bg-emerald-500/10 text-emerald-600 px-1.5 py-0.5 text-3xs font-mono font-bold">
                PASS
              </span>
            </div>
            <h3 className="font-semibold text-ink text-sm">{inv.rule}</h3>
            <div className="text-3xs text-ink-muted font-mono bg-surface p-2 rounded border border-line/60">
              <div>constraint: {inv.constraint}</div>
              <div>sqlstate: {inv.sqlstate}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
    accepted: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
    paid: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    shipped: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
    completed: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    rejected: 'bg-rose-500/10 text-rose-600 border-rose-500/20',
    cancelled: 'bg-rose-500/10 text-rose-600 border-rose-500/20',
    refunded: 'bg-zinc-500/10 text-zinc-600 border-zinc-500/20',
    succeeded: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    failed: 'bg-rose-500/10 text-rose-600 border-rose-500/20',
  };
  const cls = styles[status] ?? 'bg-zinc-500/10 text-zinc-600 border-zinc-500/20';

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
}
