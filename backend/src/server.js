
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { z } from 'zod';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const app = express();

// Render places one load-balancer hop directly in front of the web service.
// Trust only that hop so Express/rate-limit can use the forwarded client IP
// without trusting an arbitrary X-Forwarded-For chain from the public client.
app.set('trust proxy', 1);

const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
});

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error(
    'Set JWT_SECRET to a random secret of at least 32 characters'
  );
}

if (!process.env.ADMIN_PASSWORD_HASH) {
  throw new Error('Set ADMIN_PASSWORD_HASH; see README.md');
}

/*
|--------------------------------------------------------------------------
| ALLOWED FRONTEND ORIGINS
|--------------------------------------------------------------------------
*/

const origins = [
  ...(
    process.env.FRONTEND_ORIGIN ||
    'https://fashionstore.id.vn,https://www.fashionstore.id.vn'
  )
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),

  'https://fashionstore.id.vn',
  'https://www.fashionstore.id.vn',
];

app.disable('x-powered-by');

/*
|--------------------------------------------------------------------------
| SECURITY / CSP
|--------------------------------------------------------------------------
*/

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],

        scriptSrc: ["'self'", "'unsafe-inline'"],

        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://cdn.jsdelivr.net',
        ],

        imgSrc: ["'self'", 'data:', 'https:'],

        connectSrc: [
          "'self'",
          'https://fashion-store-in8c.onrender.com',
          'https://fashionstore.id.vn',
          'https://www.fashionstore.id.vn',
        ],
      },
    },
  })
);

/*
|--------------------------------------------------------------------------
| CORS
|--------------------------------------------------------------------------
*/

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Origin not allowed'));
    },

    methods: [
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
    ],

    allowedHeaders: [
      'Content-Type',
      'Authorization',
    ],

    optionsSuccessStatus: 204,
  })
);

/*
|--------------------------------------------------------------------------
| BODY PARSER
|--------------------------------------------------------------------------
*/

app.use(express.json({ limit: '1mb' }));

/*
|--------------------------------------------------------------------------
| LOGIN RATE LIMIT
|--------------------------------------------------------------------------
*/

app.use(
  '/api/v1/admin/login',
  rateLimit({
    windowMs: 900000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/*
|--------------------------------------------------------------------------
| PRODUCT VALIDATION
|--------------------------------------------------------------------------
*/

const schema = z.object({
  name: z.string().trim().min(1).max(180),

  price: z.coerce
    .number()
    .int()
    .min(0)
    .max(1000000000),

  category: z.string().trim().min(1).max(80).default('Lifestyle'),

  audience: z.string().trim().min(1).max(40).default('Nam Nữ'),

  description: z.string().trim().max(2000).default(''),

  image: z
    .string()
    .min(1)
    .max(650000)
    .regex(
      /^data:image\/(jpeg|png|webp);base64,/i,
      'Ảnh phải là JPEG, PNG hoặc WEBP.'
    ),

  sizes: z
    .record(
      z.string().max(12),
      z.coerce.number().int().min(0).max(100000)
    )
    .refine(
      (x) => Object.keys(x).length > 0 && Object.keys(x).length <= 30,
      'Nhập từ 1 đến 30 kích cỡ.'
    ),
});

const promotionSchema = z.object({
  enabled: z.boolean(),
  salePrice: z.coerce.number().int().min(0).max(1000000000).optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
});

/*
|--------------------------------------------------------------------------
| PRODUCT RESPONSE FORMAT
|--------------------------------------------------------------------------
*/

function shape(r, { applyPromotion = false } = {}) {
  const basePrice = Number(r.price_vnd || 0);
  const salePrice = r.promo_sale_price_vnd == null
    ? null
    : Number(r.promo_sale_price_vnd);
  const startsAt = r.promo_starts_at || null;
  const endsAt = r.promo_ends_at || null;
  const enabled = r.promo_enabled === true;
  const now = Date.now();
  const activePromotion = enabled && salePrice !== null && salePrice < basePrice &&
    startsAt && endsAt && Date.parse(startsAt) <= now && now < Date.parse(endsAt);
  const stock = Object.values(r.sizes || {}).reduce(
    (sum, quantity) => sum + Number(quantity || 0),
    0
  );

  return {
    id: String(r.id),
    title: r.name,
    name: r.name,
    price: applyPromotion && activePromotion ? salePrice : basePrice,
    basePrice,
    oldPrice: activePromotion ? basePrice : null,
    salePrice,
    discountPercent: activePromotion
      ? Number((((basePrice - salePrice) / basePrice) * 100).toFixed(2))
      : 0,
    activePromotion: Boolean(activePromotion),
    promotion: salePrice === null ? null : {
      enabled,
      salePrice,
      startsAt,
      endsAt,
    },
    category: r.category,
    audience: r.audience,
    description: r.description,
    image: r.image_data_url,
    sizes: r.sizes,
    active: r.active,
    stock,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    unitsSold: Number(r.units_sold || 0),
  };
}

const productWithPromotionSql = `
  SELECT p.*,
         pr.sale_price_vnd AS promo_sale_price_vnd,
         pr.starts_at AS promo_starts_at,
         pr.ends_at AS promo_ends_at,
         pr.enabled AS promo_enabled
  FROM products p
  LEFT JOIN product_promotions pr ON pr.product_id=p.id`;

const reportableOrderStatuses = ['confirmed', 'shipping', 'completed'];

/*
|--------------------------------------------------------------------------
| ADMIN AUTHENTICATION
|--------------------------------------------------------------------------
*/

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';

    const c = jwt.verify(
      h.startsWith('Bearer ') ? h.slice(7) : '',
      process.env.JWT_SECRET
    );

    if (c.role !== 'admin') {
      throw Error();
    }

    next();
  } catch {
    return res.status(401).json({
      message: 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.',
    });
  }
}

/*
|--------------------------------------------------------------------------
| VALIDATE REQUEST
|--------------------------------------------------------------------------
*/

function validated(req, res) {
  const p = schema.safeParse(req.body);

  if (!p.success) {
    res.status(400).json({
      message: p.error.issues[0]?.message || 'Dữ liệu không hợp lệ.',
    });

    return null;
  }

  return p.data;
}

/*
|--------------------------------------------------------------------------
| ERROR RESPONSE
|--------------------------------------------------------------------------
*/

function fail(res, e) {
  console.error(e);

  res.status(500).json({
    message: 'Máy chủ gặp lỗi. Vui lòng thử lại sau.',
  });
}

/*
|--------------------------------------------------------------------------
| ADMIN PAGE
|--------------------------------------------------------------------------
| https://fashion-store-in8c.onrender.com/admin.html
|--------------------------------------------------------------------------
*/

app.get('/admin.html', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(join(backendDir, 'admin.html'));
});

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get('/health', async (_q, s) => {
  try {
    await pool.query('SELECT 1');

    s.json({
      ok: true,
      service: 'dk-fashion-api',
    });
  } catch (e) {
    console.error('Health DB check failed:', e.message);

    s.status(503).json({
      ok: false,
    });
  }
});

/*
|--------------------------------------------------------------------------
| ADMIN LOGIN
|--------------------------------------------------------------------------
*/


app.post('/api/v1/admin/login', async (req, res) => {
  try {
    const username = req.body?.username;
    const pw = req.body?.password;

    if (
      typeof username !== 'string' ||
      typeof pw !== 'string' ||
      username.length > 100 ||
      pw.length > 200
    ) {
      return res.status(400).json({
        message: 'Tên đăng nhập hoặc mật khẩu không hợp lệ.',
      });
    }

    if (
      username.trim() !== 'admin' ||
      !(await bcrypt.compare(pw, process.env.ADMIN_PASSWORD_HASH))
    ) {
      return res.status(401).json({
        message: 'Tên đăng nhập hoặc mật khẩu quản trị không đúng.',
      });
    }

    return res.json({
      token: jwt.sign(
        { role: 'admin' },
        process.env.JWT_SECRET,
        {
          expiresIn: '8h',
          issuer: 'dk-fashion',
        }
      ),
    });
  } catch (e) {
    fail(res, e);
  }
});


/*
|--------------------------------------------------------------------------
| CUSTOMER PRODUCTS
|--------------------------------------------------------------------------
*/

app.get('/api/v1/products', async (_q, res) => {
  try {
    const { rows } = await pool.query(
      `${productWithPromotionSql}
       WHERE p.active=TRUE
       ORDER BY p.updated_at DESC,p.id DESC`
    );

    res.set('Cache-Control', 'no-store').json({
      products: rows.map((row) => shape(row, { applyPromotion: true })),
    });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/v1/products/bestsellers', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
              pr.sale_price_vnd AS promo_sale_price_vnd,
              pr.starts_at AS promo_starts_at,
              pr.ends_at AS promo_ends_at,
              pr.enabled AS promo_enabled,
              SUM(i.quantity)::INTEGER AS units_sold
       FROM products p
       JOIN order_items i ON i.product_id=p.id
       JOIN orders o ON o.id=i.order_id
       LEFT JOIN product_promotions pr ON pr.product_id=p.id
       WHERE p.active=TRUE AND o.status=ANY($1::text[])
       GROUP BY p.id,pr.sale_price_vnd,pr.starts_at,pr.ends_at,pr.enabled
       HAVING SUM(i.quantity)>0
       ORDER BY SUM(i.quantity) DESC,p.id DESC
       LIMIT 100`,
      [reportableOrderStatuses]
    );
    res.set('Cache-Control', 'no-store').json({
      products: rows.map((row) => ({
        ...shape(row, { applyPromotion: true }),
        badge: 'BEST SELLER',
      })),
    });
  } catch (e) {
    fail(res, e);
  }
});

/*
|--------------------------------------------------------------------------
| ADMIN PRODUCTS - GET
|--------------------------------------------------------------------------
*/

app.get('/api/v1/admin/products', auth, async (_q, res) => {
  try {
    const { rows } = await pool.query(
      `${productWithPromotionSql}
       ORDER BY p.updated_at DESC,p.id DESC`
    );

    res.json({
      products: rows.map((row) => shape(row)),
    });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/v1/admin/dashboard', auth, async (req, res) => {
  const period = ['day', 'week', 'month'].includes(req.query.period)
    ? req.query.period
    : 'day';
  const periodConfig = {
    day: { trunc: 'day', lookback: '30 days' },
    week: { trunc: 'week', lookback: '12 weeks' },
    month: { trunc: 'month', lookback: '12 months' },
  }[period];

  try {
    const [summary, sales, products, chart, topProducts] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(total_vnd) FILTER (WHERE status=ANY($1::text[])),0)::BIGINT AS revenue,
           COALESCE(SUM(total_vnd) FILTER (WHERE status=ANY($1::text[]) AND created_at::date=CURRENT_DATE),0)::BIGINT AS revenue_today,
           COUNT(*)::INTEGER AS order_count,
           COUNT(*) FILTER (WHERE status='pending')::INTEGER AS pending_count
         FROM orders`,
        [reportableOrderStatuses]
      ),
      pool.query(
        `SELECT COALESCE(SUM(i.quantity),0)::BIGINT AS units
         FROM order_items i JOIN orders o ON o.id=i.order_id
         WHERE o.status=ANY($1::text[])`,
        [reportableOrderStatuses]
      ),
      pool.query(
        `SELECT COUNT(*)::INTEGER AS active_count,
                COUNT(*) FILTER (WHERE inventory.total<=3)::INTEGER AS low_stock_count
         FROM products p
         CROSS JOIN LATERAL (
           SELECT COALESCE(SUM(value::INTEGER),0) AS total
           FROM jsonb_each_text(p.sizes)
         ) inventory
         WHERE p.active=TRUE`
      ),
      pool.query(
        `SELECT date_trunc('${periodConfig.trunc}',created_at) AS bucket,
                COALESCE(SUM(total_vnd),0)::BIGINT AS revenue
         FROM orders
         WHERE status=ANY($1::text[])
           AND created_at >= NOW()-$2::interval
         GROUP BY bucket ORDER BY bucket`,
        [reportableOrderStatuses, periodConfig.lookback]
      ),
      pool.query(
        `SELECT i.product_id,
                COALESCE(p.name,i.product_name) AS product_name,
                SUM(i.quantity)::BIGINT AS units_sold,
                COALESCE(SUM(i.quantity::BIGINT*i.unit_price_vnd),0)::BIGINT AS revenue
         FROM order_items i JOIN orders o ON o.id=i.order_id
         LEFT JOIN products p ON p.id=i.product_id
         WHERE o.status=ANY($1::text[])
         GROUP BY i.product_id,COALESCE(p.name,i.product_name)
         ORDER BY SUM(i.quantity) DESC,SUM(i.quantity::BIGINT*i.unit_price_vnd) DESC
         LIMIT 5`,
        [reportableOrderStatuses]
      ),
    ]);

    res.set('Cache-Control', 'no-store').json({
      period,
      includedStatuses: reportableOrderStatuses,
      summary: {
        revenue: Number(summary.rows[0].revenue),
        revenueToday: Number(summary.rows[0].revenue_today),
        orderCount: Number(summary.rows[0].order_count),
        pendingCount: Number(summary.rows[0].pending_count),
        activeProducts: Number(products.rows[0].active_count),
        lowStockProducts: Number(products.rows[0].low_stock_count),
        unitsSold: Number(sales.rows[0].units),
      },
      revenueSeries: chart.rows.map((row) => ({
        date: row.bucket,
        revenue: Number(row.revenue),
      })),
      topProducts: topProducts.rows.map((row) => ({
        id: row.product_id == null ? null : String(row.product_id),
        name: row.product_name,
        unitsSold: Number(row.units_sold),
        revenue: Number(row.revenue),
      })),
    });
  } catch (e) {
    fail(res, e);
  }
});

/*
|--------------------------------------------------------------------------
| ADMIN PRODUCTS - CREATE
|--------------------------------------------------------------------------
*/

app.post('/api/v1/admin/products', auth, async (req, res) => {
  const p = validated(req, res);

  if (!p) {
    return;
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO products
        (name,price_vnd,category,audience,description,image_data_url,sizes)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7::jsonb)
       RETURNING *`,
      [
        p.name,
        p.price,
        p.category,
        p.audience,
        p.description,
        p.image,
        JSON.stringify(p.sizes),
      ]
    );

    res.status(201).json({
      product: shape(rows[0]),
    });
  } catch (e) {
    fail(res, e);
  }
});

/*
|--------------------------------------------------------------------------
| ADMIN PRODUCTS - UPDATE
|--------------------------------------------------------------------------
*/

app.put('/api/v1/admin/products/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  const p = validated(req, res);

  if (!p) {
    return;
  }

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      message: 'Mã sản phẩm không hợp lệ.',
    });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE products
       SET
         name=$1,
         price_vnd=$2,
         category=$3,
         audience=$4,
         description=$5,
         image_data_url=$6,
         sizes=$7::jsonb,
         updated_at=NOW()
       WHERE id=$8
       RETURNING *`,
      [
        p.name,
        p.price,
        p.category,
        p.audience,
        p.description,
        p.image,
        JSON.stringify(p.sizes),
        id,
      ]
    );

    if (!rows.length) {
      return res.status(404).json({
        message: 'Không tìm thấy sản phẩm.',
      });
    }

    res.json({
      product: shape(rows[0]),
    });
  } catch (e) {
    fail(res, e);
  }
});

/*
|--------------------------------------------------------------------------
| ADMIN PRODUCTS - DELETE
|--------------------------------------------------------------------------
*/

app.delete('/api/v1/admin/products/:id', auth, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      message: 'Mã sản phẩm không hợp lệ.',
    });
  }

  try {
    const r = await pool.query(
      'UPDATE products SET active=FALSE,updated_at=NOW() WHERE id=$1 AND active=TRUE',
      [id]
    );

    if (!r.rowCount) {
      return res.status(404).json({
        message: 'Không tìm thấy sản phẩm.',
      });
    }

    res.status(204).end();
  } catch (e) {
    fail(res, e);
  }
});

app.patch('/api/v1/admin/products/:id/restore', auth, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ message: 'Mã sản phẩm không hợp lệ.' });
  }

  try {
    const { rows } = await pool.query(
      'UPDATE products SET active=TRUE,updated_at=NOW() WHERE id=$1 AND active=FALSE RETURNING *',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Không tìm thấy sản phẩm đã lưu trữ.' });
    }

    res.json({ product: shape(rows[0]) });
  } catch (e) {
    fail(res, e);
  }
});

app.put('/api/v1/admin/products/:id/promotion', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ message: 'Mã sản phẩm không hợp lệ.' });
  }
  const parsed = promotionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: parsed.error.issues[0]?.message || 'Thông tin ưu đãi không hợp lệ.',
    });
  }

  if (!parsed.data.enabled) {
    try {
      const result = await pool.query(
        `UPDATE product_promotions SET enabled=FALSE,updated_at=NOW()
         WHERE product_id=$1 RETURNING product_id`,
        [id]
      );
      return res.json({ enabled: false, productId: String(id), found: result.rowCount > 0 });
    } catch (e) {
      return fail(res, e);
    }
  }

  const { salePrice, startsAt, endsAt } = parsed.data;
  const starts = Date.parse(startsAt || '');
  const ends = Date.parse(endsAt || '');
  if (!Number.isFinite(salePrice) || !Number.isFinite(starts) || !Number.isFinite(ends) || starts >= ends) {
    return res.status(400).json({ message: 'Giá và khoảng thời gian ưu đãi không hợp lệ.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await client.query(
      'SELECT id,price_vnd FROM products WHERE id=$1 FOR UPDATE',
      [id]
    );
    if (!product.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Không tìm thấy sản phẩm.' });
    }
    if (salePrice >= Number(product.rows[0].price_vnd)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Giá ưu đãi phải thấp hơn giá gốc.' });
    }
    const { rows } = await client.query(
      `INSERT INTO product_promotions(product_id,sale_price_vnd,starts_at,ends_at,enabled)
       VALUES($1,$2,$3,$4,TRUE)
       ON CONFLICT(product_id) DO UPDATE SET
         sale_price_vnd=EXCLUDED.sale_price_vnd,
         starts_at=EXCLUDED.starts_at,
         ends_at=EXCLUDED.ends_at,
         enabled=TRUE,
         updated_at=NOW()
       RETURNING product_id,sale_price_vnd,starts_at,ends_at,enabled`,
      [id, salePrice, new Date(starts).toISOString(), new Date(ends).toISOString()]
    );
    await client.query('COMMIT');
    return res.json({ promotion: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    return fail(res, e);
  } finally {
    client.release();
  }
});

/*
|--------------------------------------------------------------------------
| AUTH API
|--------------------------------------------------------------------------
*/

const customerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(['/api/auth/login', '/api/auth/register'], customerAuthLimiter);

const customerToken = (user) =>
  jwt.sign(
    {
      sub: String(user.id),
      role: user.role || 'customer',
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '12h',
      issuer: 'dk-fashion',
    }
  );

/*
|--------------------------------------------------------------------------
| CUSTOMER REGISTER
|--------------------------------------------------------------------------
*/

app.post('/api/auth/register', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;

  if (
    name.length < 2 ||
    name.length > 120 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 200
  ) {
    return res.status(400).json({
      success: false,
      message: 'Vui lòng nhập tên, email hợp lệ và mật khẩu từ 8 ký tự.',
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);

    const { rows } = await pool.query(
      `INSERT INTO users(name,email,password,role)
       VALUES($1,$2,$3,'customer')
       RETURNING id,name,email,role`,
      [name, email, hash]
    );

    const user = rows[0];

    return res.status(201).json({
      success: true,
      user,
      token: customerToken(user),
    });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Email này đã được đăng ký.',
      });
    }

    return fail(res, e);
  }
});

/*
|--------------------------------------------------------------------------
| CUSTOMER LOGIN
|--------------------------------------------------------------------------
*/

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;

  if (!email || typeof password !== 'string' || password.length > 200) {
    return res.status(400).json({
      success: false,
      message: 'Email hoặc mật khẩu không hợp lệ.',
    });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id,name,email,password,role FROM users WHERE email=$1 LIMIT 1',
      [email]
    );

    if (!rows.length) {
      return res.status(401).json({
        success: false,
        message: 'Email hoặc mật khẩu không chính xác.',
      });
    }

    const userRow = rows[0];
    let valid = false;

    // One-time migration support for legacy sample records stored as plain text.
    // Hash immediately on successful login.
    if (/^\$2[aby]\$/.test(userRow.password)) {
      valid = await bcrypt.compare(password, userRow.password);
    } else if (userRow.password === password) {
      valid = true;

      const upgraded = await bcrypt.hash(password, 12);

      await pool.query(
        'UPDATE users SET password=$1,updated_at=NOW() WHERE id=$2',
        [upgraded, userRow.id]
      );
    }

    if (!valid) {
      return res.status(401).json({
        success: false,
        message: 'Email hoặc mật khẩu không chính xác.',
      });
    }

    const user = {
      id: userRow.id,
      name: userRow.name,
      email: userRow.email,
      role: userRow.role,
    };

    return res.json({
      success: true,
      user,
      token: customerToken(user),
    });
  } catch (e) {
    return fail(res, e);
  }
});

/*
|--------------------------------------------------------------------------
| GUEST COD CHECKOUT
|--------------------------------------------------------------------------
| Product prices and stock are resolved server-side.
|--------------------------------------------------------------------------
*/

app.post('/api/v1/orders', async (req, res) => {
  const customer = req.body?.customer || {};
  const items = req.body?.items;

  const name = String(customer.name || '').trim();
  const phone = String(customer.phone || '').trim();
  const address = String(customer.address || '').trim();
  const note = String(customer.note || '').trim();

  if (
    name.length < 2 ||
    name.length > 120 ||
    !/^[0-9+() .-]{9,20}$/.test(phone) ||
    address.length < 5 ||
    address.length > 250 ||
    note.length > 500 ||
    !Array.isArray(items) ||
    !items.length ||
    items.length > 50
  ) {
    return res.status(400).json({
      message: 'Thông tin nhận hàng hoặc giỏ hàng không hợp lệ.',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let total = 0;
    const resolved = [];

    for (const item of items) {
      const id = Number(item.productId);
      const qty = Number(item.quantity);
      const size = String(item.size || '').trim();

      if (
        !Number.isSafeInteger(id) ||
        id < 1 ||
        !Number.isInteger(qty) ||
        qty < 1 ||
        qty > 100 ||
        !size ||
        size.length > 12
      ) {
        throw Object.assign(
          new Error('Một sản phẩm trong giỏ hàng không hợp lệ.'),
          { status: 400 }
        );
      }

      const result = await client.query(
        'SELECT id,name,price_vnd,sizes,active FROM products WHERE id=$1 FOR UPDATE',
        [id]
      );

      if (!result.rows.length || !result.rows[0].active) {
        throw Object.assign(
          new Error('Có sản phẩm không còn được bán.'),
          { status: 409 }
        );
      }

      const product = result.rows[0];
      const promotionResult = await client.query(
        `SELECT sale_price_vnd,starts_at,ends_at,enabled
         FROM product_promotions WHERE product_id=$1`,
        [id]
      );
      const promotion = promotionResult.rows[0] || {};
      const available = Number(product.sizes?.[size] ?? 0);

      if (available < qty) {
        throw Object.assign(
          new Error(
            `Sản phẩm ${product.name} size ${size} không đủ tồn kho.`
          ),
          { status: 409 }
        );
      }

      const basePrice = Number(product.price_vnd);
      const salePrice = promotion.sale_price_vnd == null
        ? null
        : Number(promotion.sale_price_vnd);
      const now = Date.now();
      const promotionIsValid = promotion.enabled === true &&
        salePrice !== null && salePrice < basePrice &&
        Date.parse(promotion.starts_at) <= now &&
        now < Date.parse(promotion.ends_at);
      const unitPrice = promotionIsValid ? salePrice : basePrice;
      total += unitPrice * qty;

      resolved.push({
        product,
        size,
        qty,
        unitPrice,
      });
    }

    const orderResult = await client.query(
      `INSERT INTO orders
        (customer_name,customer_phone,customer_address,customer_note,payment_method,status,total_vnd)
       VALUES
        ($1,$2,$3,$4,'COD','pending',$5)
       RETURNING id`,
      [name, phone, address, note, total]
    );

    const orderId = orderResult.rows[0].id;

    for (const item of resolved) {
      await client.query(
        `INSERT INTO order_items
          (order_id,product_id,product_name,unit_price_vnd,size,quantity)
         VALUES
          ($1,$2,$3,$4,$5,$6)`,
        [
          orderId,
          item.product.id,
          item.product.name,
          item.unitPrice,
          item.size,
          item.qty,
        ]
      );

      const nextSizes = {
        ...item.product.sizes,
        [item.size]:
          Number(item.product.sizes[item.size]) - item.qty,
      };

      await client.query(
        'UPDATE products SET sizes=$1::jsonb,updated_at=NOW() WHERE id=$2',
        [JSON.stringify(nextSizes), item.product.id]
      );
    }

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      orderId: String(orderId),
      orderNumber: `DK-${orderId}`,
      total,
    });
  } catch (e) {
    await client.query('ROLLBACK');

    if (e.status) {
      return res.status(e.status).json({
        message: e.message,
      });
    }

    return fail(res, e);
  } finally {
    client.release();
  }
});

/*
|--------------------------------------------------------------------------
| ADMIN ORDERS
|--------------------------------------------------------------------------
*/

app.get('/api/v1/admin/orders', auth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         o.*,
         COALESCE(
           json_agg(
             json_build_object(
               'name',i.product_name,
               'size',i.size,
               'quantity',i.quantity,
               'unitPrice',i.unit_price_vnd
             )
             ORDER BY i.id
           ) FILTER (WHERE i.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM orders o
       LEFT JOIN order_items i ON i.order_id=o.id
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT 200`
    );

    res.json({
      orders: rows,
    });
  } catch (e) {
    fail(res, e);
  }
});

/*
|--------------------------------------------------------------------------
| ADMIN ORDER STATUS UPDATE
|--------------------------------------------------------------------------
*/

app.patch('/api/v1/admin/orders/:id/status', auth, async (req, res) => {
  const allowed = [
    'pending',
    'confirmed',
    'shipping',
    'completed',
    'cancelled',
  ];

  const status = String(req.body?.status || '');
  const id = Number(req.params.id);

  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    !allowed.includes(status)
  ) {
    return res.status(400).json({
      message: 'Mã đơn hoặc trạng thái không hợp lệ.',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id,status FROM orders WHERE id=$1 FOR UPDATE',
      [id]
    );

    if (!existing.rows.length) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        message: 'Không tìm thấy đơn hàng.',
      });
    }

    const oldStatus = existing.rows[0].status;

    if (oldStatus === 'cancelled' && status !== 'cancelled') {
      await client.query('ROLLBACK');

      return res.status(409).json({
        message: 'Đơn đã hủy không thể mở lại; vui lòng tạo đơn mới.',
      });
    }

    if (status === 'cancelled' && oldStatus !== 'cancelled') {
      const items = await client.query(
        `SELECT product_id,size,quantity
         FROM order_items
         WHERE order_id=$1 AND product_id IS NOT NULL`,
        [id]
      );

      for (const item of items.rows) {
        const product = await client.query(
          'SELECT sizes FROM products WHERE id=$1 FOR UPDATE',
          [item.product_id]
        );

        if (product.rows.length) {
          const sizes = {
            ...product.rows[0].sizes,
            [item.size]:
              Number(product.rows[0].sizes?.[item.size] || 0) +
              Number(item.quantity),
          };

          await client.query(
            'UPDATE products SET sizes=$1::jsonb,updated_at=NOW() WHERE id=$2',
            [JSON.stringify(sizes), item.product_id]
          );
        }
      }
    }

    const updated = await client.query(
      'UPDATE orders SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING id,status',
      [status, id]
    );

    await client.query('COMMIT');

    return res.json({
      order: updated.rows[0],
    });
  } catch (e) {
    await client.query('ROLLBACK');

    return fail(res, e);
  } finally {
    client.release();
  }
});

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use((e, _q, res, _n) => {
  if (e.message === 'Origin not allowed') {
    return res.status(403).json({
      message: 'Nguồn truy cập không được phép.',
    });
  }

  fail(res, e);
});

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`DK FASHION API listening on ${port}`);
});
