/** Placeholder shown while the catalog query is in flight. */
export function ProductGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading products"
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="h-40 animate-pulse rounded-lg border border-line bg-surface-raised"
        />
      ))}
    </div>
  );
}
