/**
 * Sellers repository for workflow 2 and shop details.
 */
import { query } from '@/server/db/client';

export interface SellerProfileSummary {
  readonly userId: string;
  readonly shopName: string;
  readonly slug: string;
  readonly description: string | null;
  readonly status: string;
  readonly payoutCurrency: string;
  readonly ratingAverageBp: number;
  readonly ratingCount: number;
  readonly productCount: number;
}

export interface SellerReviewItem {
  readonly id: string;
  readonly rating: number;
  readonly body: string | null;
  readonly authorName: string;
  readonly orderPublicCode: string;
  readonly createdAt: string;
}

interface RawSellerRow {
  readonly user_id: string;
  readonly shop_name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly status: string;
  readonly payout_currency: string;
  readonly rating_average_bp: number;
  readonly rating_count: number;
  readonly product_count: number;
}

interface RawReviewRow {
  readonly id: string;
  readonly rating: number;
  readonly body: string | null;
  readonly author_name: string;
  readonly order_public_code: string;
  readonly created_at: string;
}

function toSeller(row: RawSellerRow): SellerProfileSummary {
  return {
    userId: row.user_id,
    shopName: row.shop_name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    payoutCurrency: row.payout_currency,
    ratingAverageBp: row.rating_average_bp,
    ratingCount: row.rating_count,
    productCount: row.product_count,
  };
}

function toReview(row: RawReviewRow): SellerReviewItem {
  return {
    id: row.id,
    rating: row.rating,
    body: row.body,
    authorName: row.author_name,
    orderPublicCode: row.order_public_code,
    createdAt: row.created_at,
  };
}

export async function listSellers(): Promise<readonly SellerProfileSummary[]> {
  const sql = `
    SELECT sp.user_id,
           sp.shop_name,
           sp.slug,
           sp.description,
           sp.status,
           sp.payout_currency,
           sp.rating_average_bp,
           sp.rating_count,
           count(p.id)::int AS product_count
      FROM seller_profiles sp
      LEFT JOIN products p ON p.seller_id = sp.user_id AND p.status = 'active'
     WHERE sp.status = 'active'
     GROUP BY sp.user_id, sp.shop_name, sp.slug, sp.description, sp.status, sp.payout_currency, sp.rating_average_bp, sp.rating_count
     ORDER BY sp.shop_name ASC;
  `;
  const { rows } = await query<RawSellerRow>(sql);
  return rows.map(toSeller);
}

export async function getSellerBySlug(slug: string): Promise<SellerProfileSummary | null> {
  const sql = `
    SELECT sp.user_id,
           sp.shop_name,
           sp.slug,
           sp.description,
           sp.status,
           sp.payout_currency,
           sp.rating_average_bp,
           sp.rating_count,
           count(p.id)::int AS product_count
      FROM seller_profiles sp
      LEFT JOIN products p ON p.seller_id = sp.user_id AND p.status = 'active'
     WHERE sp.slug = $1
     GROUP BY sp.user_id, sp.shop_name, sp.slug, sp.description, sp.status, sp.payout_currency, sp.rating_average_bp, sp.rating_count
     LIMIT 1;
  `;
  const { rows } = await query<RawSellerRow>(sql, [slug]);
  return rows[0] ? toSeller(rows[0]) : null;
}

export async function getSellerReviews(sellerUserId: string): Promise<readonly SellerReviewItem[]> {
  const sql = `
    SELECT r.id,
           r.rating,
           r.body,
           u.full_name   AS author_name,
           o.public_code AS order_public_code,
           r.created_at
      FROM reviews r
      JOIN users u  ON u.id = r.author_id
      JOIN orders o ON o.id = r.order_id
     WHERE r.subject_seller_id = $1
       AND r.deleted_at IS NULL
     ORDER BY r.created_at DESC
     LIMIT 20;
  `;
  const { rows } = await query<RawReviewRow>(sql, [sellerUserId]);
  return rows.map(toReview);
}
