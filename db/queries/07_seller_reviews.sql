-- ============================================================================
-- 07_seller_reviews.sql
-- Action 5 of 5: a buyer reads a seller's reviews, and leaves one.
--
-- Index: reviews_seller_live_idx (subject_seller_id, created_at DESC)
--        WHERE deleted_at IS NULL
--        db/migrations/007_indexes.sql:109
--
-- Partial to live reviews. The storefront's view is the only hot one, and
-- filtering out moderated reviews in the index means the storefront scan
-- touches only rows it will return. A moderator's unfiltered view uses the same
-- index less efficiently, which is the correct trade: one expensive query an
-- admin runs deliberately beats a permanent tax on every storefront render.
--
-- The rating comes from seller_profiles.rating_average_bp, the denormalised
-- aggregate, NOT from avg() over this page. Two reasons. Recomputing per page
-- makes the number depend on pagination, so the "4.8 from 212" in the header
-- would disagree with the average of the ten reviews shown beneath it. And a
-- window function over the page would silently truncate the population. The
-- aggregate is maintained by refresh_seller_rating (006_reviews.sql:175) and
-- each review keeps a snapshot of the pre-review value, so the historical figure
-- is still recoverable. See docs/11-denormalisation.md.
-- ============================================================================

SELECT r.id,
       r.rating,
       r.body,
       r.subject_rating_average_bp_snapshot,
       r.subject_rating_count_snapshot,
       r.created_at,
       u.full_name            AS author_name,
       o.public_code
  FROM reviews r
  JOIN users  u ON u.id = r.author_id
  JOIN orders o ON o.id = r.order_id
 WHERE r.subject_seller_id = $1::uuid
   AND r.deleted_at IS NULL
 ORDER BY r.created_at DESC, r.id DESC
 LIMIT $2 OFFSET $3;

-- The header figure. One row, read from the maintained aggregate, deliberately
-- not derived from the rows above. See the note in the header comment.
SELECT sp.rating_average_bp,
       sp.rating_count,
       sp.shop_name,
       sp.slug
  FROM seller_profiles sp
 WHERE sp.user_id = $1::uuid;
