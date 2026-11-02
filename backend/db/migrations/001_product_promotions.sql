-- Additive only: creates promotion metadata without changing existing products,
-- orders, or order_items. Review and back up the Supabase database before applying.
CREATE TABLE IF NOT EXISTS product_promotions (
 product_id BIGINT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
 sale_price_vnd INTEGER NOT NULL CHECK (sale_price_vnd >= 0),
 starts_at TIMESTAMPTZ NOT NULL,
 ends_at TIMESTAMPTZ NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT product_promotions_valid_window CHECK (starts_at < ends_at)
);

CREATE INDEX IF NOT EXISTS product_promotions_active_window_idx
 ON product_promotions(enabled, starts_at, ends_at);
