CREATE TABLE IF NOT EXISTS products (
 id BIGSERIAL PRIMARY KEY,
 name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 180),
 price_vnd INTEGER NOT NULL CHECK (price_vnd >= 0),
 category TEXT NOT NULL DEFAULT 'Lifestyle',
 audience TEXT NOT NULL DEFAULT 'Nam Nữ',
 description TEXT NOT NULL DEFAULT '',
 image_data_url TEXT NOT NULL CHECK (char_length(image_data_url) <= 700000),
 sizes JSONB NOT NULL DEFAULT '{}'::jsonb,
 active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS products_active_updated_idx ON products(active, updated_at DESC);
