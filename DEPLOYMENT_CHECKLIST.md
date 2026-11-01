# DK FASHION deployment checklist (read before publishing)

## 1. Backup and database
- Export/backup the Supabase database first.
- Run the updated `backend/db/schema.sql` in Supabase SQL Editor.
- Confirm `products`, `users`, `orders`, and `order_items` exist.

## 2. Render API
- Keep the existing service; do not change DNS for the custom domain.
- Ensure its Docker build context matches the `backend/Dockerfile`. For a service configured with backend as Root Directory, use `Dockerfile` as the Dockerfile path. If the current live service has another working setup, preserve it and align the build context rather than guessing.
- Confirm environment variables: `DATABASE_URL`, `NODE_ENV=production`, `FRONTEND_ORIGIN=https://fashionstore.id.vn` (plus any exact live origin actually used), `JWT_SECRET` (random, private, 32+ chars), and `ADMIN_PASSWORD_HASH` (bcrypt output, not plaintext).
- Confirm `/health` returns `ok:true` after deploy.

## 3. GitHub Pages frontend
- Publish the revised `index.html` to the existing Pages source branch.
- Preserve `CNAME` containing `fashionstore.id.vn` and existing Pages custom-domain settings.
- Do not upload backend secrets or `.env` files.

## 4. Functional test
- Admin login works.
- Add a test item with an image under the Admin size limit; confirm it appears in Admin list, Supabase products, and storefront.
- Test one COD order against a test product/size. Confirm order and order_items rows exist and inventory decreased.
- Cancel the test order in Admin and confirm inventory is restored.
- Check customer account registration/login and test from a private browser session.

## Security reminder
Never share or commit the Supabase connection string, JWT secret, admin password, or `.env`. Rotate credentials that were previously exposed.
