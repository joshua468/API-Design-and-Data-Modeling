/**
 * Enhanced ProductCard with high-end typography, currency formatting, and stock status.
 */
import { formatMoney, money } from '@/lib/money';

export interface ProductCardData {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string;
  readonly priceMinor: number;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly inStock: boolean;
  readonly stockPolicy: 'tracked' | 'unlimited';
  readonly stockQuantity?: number | null;
  readonly shopName: string;
  readonly ratingCount: number;
  readonly ratingAverageBp: number;
}

export function ProductCard({ product }: { product: ProductCardData }) {
  const rating = product.ratingAverageBp > 0 ? (product.ratingAverageBp / 100).toFixed(1) : null;

  return (
    <article className="group card-hover flex flex-col justify-between rounded-xl border border-line bg-surface-raised p-5 shadow-xs transition-all duration-200">
      <div>
        <div className="flex items-start justify-between gap-3 mb-2.5">
          <span className="inline-flex items-center rounded-md bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent tracking-wide uppercase">
            {product.category}
          </span>
          {product.inStock ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft/60 px-2.5 py-0.5 text-xs font-medium text-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
              {product.stockPolicy === 'tracked' && product.stockQuantity !== null
                ? `${product.stockQuantity} in stock`
                : 'In stock'}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-danger-soft px-2.5 py-0.5 text-xs font-medium text-danger">
              Out of stock
            </span>
          )}
        </div>

        <h3 className="font-semibold text-ink text-base group-hover:text-accent transition-colors duration-150 line-clamp-1">
          {product.name}
        </h3>

        {product.description && (
          <p className="mt-1.5 line-clamp-2 text-sm text-ink-muted leading-relaxed">
            {product.description}
          </p>
        )}
      </div>

      <div className="mt-5 pt-3.5 border-t border-line/70 flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-xs text-ink-muted font-medium flex items-center gap-1">
            {product.shopName}
            {rating && (
              <span className="inline-flex items-center text-amber-500 font-semibold text-xs ml-1">
                ★ {rating} <span className="text-ink-faint font-normal ml-0.5">({product.ratingCount})</span>
              </span>
            )}
          </span>
          <span className="text-lg font-bold text-ink tracking-tight mt-0.5">
            {formatMoney(money(product.priceMinor, product.currencyCode, product.currencyExponent))}
          </span>
        </div>

        <button
          type="button"
          className="cursor-pointer inline-flex items-center justify-center rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:bg-accent-hover active:scale-95 transition-all duration-150"
        >
          View Item
        </button>
      </div>
    </article>
  );
}
