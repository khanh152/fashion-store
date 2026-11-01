# DK FASHION — source upgrade (GitHub Pages + Render + Supabase)

This is a code update based on the ZIP supplied in the conversation. It keeps the existing storefront design and custom domain `fashionstore.id.vn`; it does not deploy or change the live GitHub repository automatically.

## Main changes

- Storefront requests use the configured Render API base (`https://fashion-store-in8c.onrender.com`) rather than same-origin `/api/...` paths on GitHub Pages.
- The storefront loads products from `GET /api/v1/products`; the embedded demo catalog remains as a fallback if the API has no product records or is unreachable.
- Product detail sizes are built from the inventory values returned by Admin.
- Account dialog connects to customer `POST /api/auth/login` and `POST /api/auth/register`, displays API errors, and stores the returned customer token/user. Customer passwords are bcrypt-hashed.
- Admin page retains protected product create/update/hide flows and includes a COD order table with status updates.
- COD checkout sends product IDs, sizes and quantities. Backend resolves price from PostgreSQL, validates inventory, uses row locks/transaction, stores order and items, and decreases stock.
- Cancelling a not-yet-cancelled order restores its reserved stock in a transaction.
- Removed default plaintext demo-user inserts from schema. Successful legacy plaintext login is upgraded to bcrypt once; do not keep demo credentials in production.

## Important: apply the database schema first

Before deploying the new backend, open Supabase SQL Editor and run the complete `backend/db/schema.sql`. It uses `IF NOT EXISTS` for tables/indexes and adds the order tables required by the new COD API. Back up your database before applying any production migration.

The schema creates `products`, `users`, `orders`, and `order_items`. It intentionally does not seed known demo passwords. Customer accounts are created through the registration API. Admin access remains separate and uses `ADMIN_PASSWORD_HASH` in Render.

## Render environment variables

Set these in the Render Web Service environment (never commit real values):

- `DATABASE_URL`: Supabase PostgreSQL connection string.
- `NODE_ENV`: `production`.
- `FRONTEND_ORIGIN`: comma-separated exact origins, e.g. `https://fashionstore.id.vn,https://www.fashionstore.id.vn` if the `www` host is actually used.
- `JWT_SECRET`: a randomly generated private string with at least 32 characters.
- `ADMIN_PASSWORD_HASH`: bcrypt hash of your chosen Admin password (generated locally with bcryptjs).

The admin page is served by Render at `https://fashion-store-in8c.onrender.com/admin.html`. Keep the existing Render service and GitHub Pages custom domain; the code does not require changing DNS.

## Deploy sequence

1. Back up the Supabase project and run `backend/db/schema.sql` in Supabase SQL Editor.
2. Review the environment variables in Render. Rotate any database credential or JWT secret that was exposed in a chat or public repository.
3. Deploy the updated `backend/` folder to the configured Render service (Docker build context remains repository root, Dockerfile at `backend/Dockerfile` if that is how the service is configured; verify the existing Render Root Directory/Dockerfile setting before deployment).
4. Verify `https://fashion-store-in8c.onrender.com/health` returns `{ "ok": true, "service": "dk-fashion-api" }`.
5. Publish the updated `index.html` to the existing GitHub Pages branch/repository while preserving `CNAME` and the current domain configuration.
6. Open the storefront, add a product through Admin, verify it appears on the storefront, and test a COD order with a non-production/test product before accepting real orders.

## API endpoints in this version

- `GET /health`
- `GET /api/v1/products`
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
