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

-- BỔ SUNG BẢNG USERS CHO POSTGRESQL
CREATE TABLE IF NOT EXISTS users (
 id BIGSERIAL PRIMARY KEY,
 name TEXT NOT NULL,
 email TEXT UNIQUE NOT NULL,
 password TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Không tạo tài khoản/mật khẩu mẫu mặc định trong schema production.
-- Tạo tài khoản khách qua API /api/auth/register; tài khoản quản trị dùng ADMIN_PASSWORD_HASH riêng trên Render.

-- Orders / COD checkout. Execute this migration in Supabase SQL Editor before deploying the order API.
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  customer_name TEXT NOT NULL CHECK (char_length(customer_name) BETWEEN 2 AND 120),
  customer_phone TEXT NOT NULL CHECK (char_length(customer_phone) BETWEEN 9 AND 20),
  customer_address TEXT NOT NULL CHECK (char_length(customer_address) BETWEEN 5 AND 250),
  customer_note TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT 'COD' CHECK (payment_method = 'COD'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','shipping','completed','cancelled')),
  total_vnd BIGINT NOT NULL CHECK (total_vnd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  unit_price_vnd INTEGER NOT NULL CHECK (unit_price_vnd >= 0),
  size TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);

-- Passwords must be bcrypt hashes. Remove old demo credentials and create a real admin/customer only with a bcrypt hash.
-- Do not insert or commit real credentials into a public repository.
