# DK FASHION — source upgrade (GitHub Pages + Render + Supabase)

This is a code update based on the ZIP supplied in the conversation. It keeps the existing storefront design and custom domain `fashionstore.id.vn`; it does not deploy or change the live GitHub repository automatically.

## Main changes

- Storefront requests use the configured Render API base (`https://fashion-store-in8c.onrender.com`) rather than same-origin `/api/...` paths on GitHub Pages.
- The storefront requests 12 products at a time from `GET /api/v1/products`; search, category/audience filters and sorting are applied by the API.
- The THỂ THAO collection has exactly six filters: TẤT CẢ, GIÀY, DÉP, QUẦN, ÁO, and PHỤ KIỆN. Admin's primary category is NAM, NỮ, TRẺ EM, or THỂ THAO; sports products use the existing `category` column with a `Thể thao - <subcategory>` value and `audience=Thể thao`. No schema change is required.
- Old sports collection labels are recognized by the read-only product filter for compatibility. No existing product is reclassified automatically. Admin suggests a subcategory from the product name for legacy rows, and only saves the new category after an administrator reviews and explicitly saves that product.
- The old LIFESTYLE and CHẠY BỘ labels are not navigation/filter buttons. GIÁ TỐT is not a storefront filter. Legacy database rows with those labels remain unchanged unless an administrator explicitly edits and saves them.
- For Live Server development, the API CORS policy accepts HTTP origins on `localhost`, `127.0.0.1`, and `[::1]` (including Live Server's selected port); other origins must be listed in `FRONTEND_ORIGIN`.
- The storefront accepts both the paginated response and the previous `{ products: [...] }` response during a rolling backend/frontend update.
- Public product-list responses contain product metadata only. Product photos remain in the existing `image_data_url` column and are served separately from `/api/v1/products/:id/image`, then lazy-loaded by the storefront.
- The storefront caches short-lived product-list responses and requests versioned product-image URLs with `no-store` image responses, preventing an old cached image from being reused. Failed product images are not replaced with sample photos. Images remain in the existing `image_data_url` column.
- Admin product lists are also paginated and omit image data; thumbnails are fetched lazily through the authenticated admin image endpoint, and the original image is fetched only when editing a product.
- These performance changes do not require a database migration. Existing product rows, IDs, and Base64 images are left untouched.
- Product detail sizes are built from the inventory values returned by Admin.
- Account dialog connects to customer `POST /api/auth/login` and `POST /api/auth/register`, displays API errors, and stores the returned customer token/user. Customer passwords are bcrypt-hashed.
- Admin page retains protected product create/update/hide flows and includes a COD order table with status updates.
- COD checkout sends product IDs, sizes and quantities. Backend resolves price from PostgreSQL, validates inventory, uses row locks/transaction, stores order and items, and decreases stock.
- Cancelling a not-yet-cancelled order restores its reserved stock in a transaction.
- Removed default plaintext demo-user inserts from schema. Successful legacy plaintext login is upgraded to bcrypt once; do not keep demo credentials in production.

## Database schema prerequisite

The performance changes in this version do not alter the database schema and do not require running SQL. If setting up the existing backend for the first time, the existing application schema in `backend/db/schema.sql` must already have been applied. Do not rerun or modify it as part of this performance update.

The schema creates `products`, `users`, `orders`, and `order_items`. It intentionally does not seed known demo passwords. Customer accounts are created through the registration API. Admin access remains separate and uses `ADMIN_PASSWORD_HASH` in Render.

## Local development

When the storefront is served over HTTP from `localhost`, `127.0.0.1`, or `[::1]`, it automatically uses the local API at port `3000`. Other hosts continue to use the configured Render API. The backend CORS policy permits HTTP loopback origins for Live Server.

1. Copy `backend/.env.example` to `backend/.env` and fill in `DATABASE_URL`, `JWT_SECRET` (at least 32 characters), and `ADMIN_PASSWORD_HASH` using values you already control. Do not commit `backend/.env` or paste secret values into chat.
2. In PowerShell, run `npm.cmd install` from the `backend` directory.
3. Run `npm.cmd start` from the same directory. The API listens on port `3000` by default; set `PORT` in your private `.env` only if that port is already in use.
4. Start Live Server from the project root and open its `http://127.0.0.1:...` or `http://localhost:...` URL. Check `http://localhost:3000/health`, then test the product list and image endpoints.

## Render environment variables

Set these in the Render Web Service environment (never commit real values):

- `DATABASE_URL`: Supabase PostgreSQL connection string.
- `NODE_ENV`: `production`.
- `FRONTEND_ORIGIN`: comma-separated exact origins, e.g. `https://fashionstore.id.vn,https://www.fashionstore.id.vn` if the `www` host is actually used.
- `JWT_SECRET`: a randomly generated private string with at least 32 characters.
- `ADMIN_PASSWORD_HASH`: bcrypt hash of your chosen Admin password (generated locally with bcryptjs).

The admin page is served by Render at `https://fashion-store-in8c.onrender.com/admin.html`. Keep the existing Render service and GitHub Pages custom domain; the code does not require changing DNS.

## Deploy sequence

1. Confirm the existing application schema has already been applied; this performance update does not require a migration or any database writes.
2. Review the environment variables in Render. Rotate any database credential or JWT secret that was exposed in a chat or public repository.
3. Deploy the updated `backend/` folder to the configured Render service (Docker build context remains repository root, Dockerfile at `backend/Dockerfile` if that is how the service is configured; verify the existing Render Root Directory/Dockerfile setting before deployment).
4. Verify `https://fashion-store-in8c.onrender.com/health` returns `{ "ok": true, "service": "dk-fashion-api" }`.
5. Publish the updated `index.html` to the existing GitHub Pages branch/repository while preserving `CNAME` and the current domain configuration.
6. Open the storefront, add a product through Admin, verify it appears on the storefront, and test a COD order with a non-production/test product before accepting real orders.

## API endpoints in this version

- `GET /health`
- `GET /api/v1/products?page=1&limit=12` (supports `q`, `category`, `audience`, `department=sports`, and `sort` filters; maximum page size is 100)
- `GET /api/v1/products/:id/image` (serves the existing product image without embedding it in the product-list JSON)
- `GET /api/v1/admin/products?page=1&limit=20` (requires admin token; supports `q`, `category`, and `audience`; maximum page size is 100)
- `GET /api/v1/admin/products/:id/image` (requires admin token)
- `POST /api/v1/admin/login`
- `GET /api/v1/admin/products`
- `POST /api/v1/admin/products`
- `PUT /api/v1/admin/products/:id`
- `DELETE /api/v1/admin/products/:id` (soft-hide)
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/v1/orders` (guest COD)
- `GET /api/v1/admin/orders`
- `PATCH /api/v1/admin/orders/:id/status`

## Limitations / production checklist

- This ZIP is source code, not an automatic live deployment. The Supabase schema and Render environment need to be applied by the owner.
- The current Admin stores uploaded product images as data URLs in PostgreSQL. It is acceptable for a small catalog but not ideal at scale; object storage (e.g. Supabase Storage) is a better production option.
- The customer area has account registration/login, but a full profile editor, password reset/email verification and customer order-history screen are not included in this pass.
- COD order statuses are `pending`, `confirmed`, `shipping`, `completed`, `cancelled`. Cancellation restores stock; changing a cancelled order back is blocked.
- Test deployment, CORS, database migrations, file upload sizes, and real checkout end-to-end before taking live orders.
