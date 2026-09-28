/**
 * GET /api/v1/products -- workflow 1, a buyer browses products.
 *
 * Contract:
 *   auth      none (browsing is public)
 *   query     limit, offset, category, seller, q
 *   success   200 { data: [...], meta: { total, limit, offset } }
 *   errors    400 invalid_pagination
 *
 * The frontend calls this. No screen reads the database directly, which is the
 * whole reason this route exists rather than a server component querying in
 * place -- otherwise "the UI shows the database" and "the API is correct" become
 * two claims that drift apart.
 */
import { z } from 'zod';
import { listCatalogProducts } from '@/server/repositories/catalog';
import { apiError, fromPgError, json } from '@/server/http/responses';

// The catalog is live data; never prerender it.
export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(60).default(24),
  offset: z.coerce.number().int().min(0).default(0),
  category: z.string().trim().min(1).max(80).optional(),
  seller: z.string().trim().min(1).max(80).optional(),
  q: z.string().trim().min(1).max(120).optional(),
});

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const parsed = QuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
    category: url.searchParams.get('category') ?? undefined,
    seller: url.searchParams.get('seller') ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
  });

  if (!parsed.success) {
    return apiError(400, 'invalid_pagination', 'One or more query parameters are invalid.', {
      fields: Object.fromEntries(
        parsed.error.issues.map((issue) => [String(issue.path[0] ?? 'query'), issue.message])
      ),
    });
  }

  const { limit, offset, category, seller, q } = parsed.data;

  try {
    const page = await listCatalogProducts({
      limit,
      offset,
      ...(category !== undefined ? { category } : {}),
      ...(seller !== undefined ? { sellerSlug: seller } : {}),
      ...(q !== undefined ? { search: q } : {}),
    });

    return json({
      data: page.products,
      meta: { total: page.total, limit: page.limit, offset: page.offset },
    });
  } catch (error) {
    return fromPgError(error);
  }
}
