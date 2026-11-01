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

const origins = (process.env.FRONTEND_ORIGIN || 'https://fashionstore.id.vn')
  .split(',')
  .map((x) => x.trim());

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
          "https://cdn.jsdelivr.net",
        ],

        imgSrc: ["'self'", "data:", "https:"],

        connectSrc: [
          "'self'",
          "https://fashion-store-in8c.onrender.com",
          "https://fashionstore.id.vn",
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
    origin(o, cb) {
      if (!o || origins.includes(o)) {
        return cb(null, true);
      }

      cb(new Error('Origin not allowed'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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

/*
|--------------------------------------------------------------------------
| PRODUCT RESPONSE FORMAT
|--------------------------------------------------------------------------
*/

const shape = (r) => ({
  id: String(r.id),
  title: r.name,
  name: r.name,
  price: r.price_vnd,
  category: r.category,
  audience: r.audience,
  description: r.description,
  image: r.image_data_url,
  sizes: r.sizes,

  stock: Object.values(r.sizes || {}).reduce(
    (a, n) => a + Number(n || 0),
    0
  ),

  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

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
    const pw = req.body?.password;

    if (typeof pw !== 'string' || pw.length > 200) {
      return res.status(400).json({
        message: 'Mật khẩu không hợp lệ.',
      });
    }

    if (!(await bcrypt.compare(pw, process.env.ADMIN_PASSWORD_HASH))) {
      return res.status(401).json({
        message: 'Mật khẩu quản trị không đúng.',
      });
    }

    res.json({
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
      'SELECT * FROM products WHERE active=TRUE ORDER BY updated_at DESC,id DESC'
    );

    res.set('Cache-Control', 'no-store').json({
      products: rows.map(shape),
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
      'SELECT * FROM products ORDER BY updated_at DESC,id DESC'
    );

    res.json({
      products: rows.map(shape),
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
/*
|--------------------------------------------------------------------------
| AUTH API
|--------------------------------------------------------------------------
*/
const customerAuthLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });
app.use(['/api/auth/login', '/api/auth/register'], customerAuthLimiter);

const customerToken = (user) => jwt.sign(
  { sub: String(user.id), role: user.role || 'customer' },
  process.env.JWT_SECRET,
  { expiresIn: '12h', issuer: 'dk-fashion' }
);

app.post('/api/auth/register', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  if (name.length < 2 || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 8 || password.length > 200) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập tên, email hợp lệ và mật khẩu từ 8 ký tự.' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users(name,email,password,role) VALUES($1,$2,$3,'customer') RETURNING id,name,email,role`,
      [name, email, hash]
    );
    const user = rows[0];
    return res.status(201).json({ success: true, user, token: customerToken(user) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ success: false, message: 'Email này đã được đăng ký.' });
    return fail(res, e);
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  if (!email || typeof password !== 'string' || password.length > 200) {
    return res.status(400).json({ success: false, message: 'Email hoặc mật khẩu không hợp lệ.' });
  }
  try {
    const { rows } = await pool.query('SELECT id,name,email,password,role FROM users WHERE email=$1 LIMIT 1', [email]);
    if (!rows.length) return res.status(401).json({ success: false, message: 'Email hoặc mật khẩu không chính xác.' });
    const userRow = rows[0];
    let valid = false;
    // One-time migration support for legacy sample records stored as plain text: hash immediately on successful login.
    if (/^\$2[aby]\$/.test(userRow.password)) {
      valid = await bcrypt.compare(password, userRow.password);
    } else if (userRow.password === password) {
      valid = true;
      const upgraded = await bcrypt.hash(password, 12);
      await pool.query('UPDATE users SET password=$1,updated_at=NOW() WHERE id=$2', [upgraded, userRow.id]);
    }
    if (!valid) return res.status(401).json({ success: false, message: 'Email hoặc mật khẩu không chính xác.' });
    const user = { id: userRow.id, name: userRow.name, email: userRow.email, role: userRow.role };
    return res.json({ success: true, user, token: customerToken(user) });
  } catch (e) {
    return fail(res, e);
  }
});

// Guest COD checkout. Product prices and availability are resolved server-side, never trusted from browser data.
app.post('/api/v1/orders', async (req, res) => {
  const customer = req.body?.customer || {};
  const items = req.body?.items;
  const name = String(customer.name || '').trim();
  const phone = String(customer.phone || '').trim();
  const address = String(customer.address || '').trim();
  const note = String(customer.note || '').trim();
  if (name.length < 2 || name.length > 120 || !/^[0-9+() .-]{9,20}$/.test(phone) || address.length < 5 || address.length > 250 || note.length > 500 || !Array.isArray(items) || !items.length || items.length > 50) {
    return res.status(400).json({ message: 'Thông tin nhận hàng hoặc giỏ hàng không hợp lệ.' });
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
      if (!Number.isSafeInteger(id) || id < 1 || !Number.isInteger(qty) || qty < 1 || qty > 100 || !size || size.length > 12) {
        throw Object.assign(new Error('Một sản phẩm trong giỏ hàng không hợp lệ.'), { status: 400 });
      }
      const result = await client.query('SELECT id,name,price_vnd,sizes,active FROM products WHERE id=$1 FOR UPDATE', [id]);
      if (!result.rows.length || !result.rows[0].active) throw Object.assign(new Error('Có sản phẩm không còn được bán.'), { status: 409 });
      const product = result.rows[0];
      const available = Number(product.sizes?.[size] ?? 0);
      if (available < qty) throw Object.assign(new Error(`Sản phẩm ${product.name} size ${size} không đủ tồn kho.`), { status: 409 });
      total += Number(product.price_vnd) * qty;
      resolved.push({ product, size, qty });
    }
    const orderResult = await client.query(
      `INSERT INTO orders(customer_name,customer_phone,customer_address,customer_note,payment_method,status,total_vnd)
       VALUES($1,$2,$3,$4,'COD','pending',$5) RETURNING id`,
      [name, phone, address, note, total]
    );
    const orderId = orderResult.rows[0].id;
    for (const item of resolved) {
      await client.query(
        `INSERT INTO order_items(order_id,product_id,product_name,unit_price_vnd,size,quantity)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [orderId, item.product.id, item.product.name, item.product.price_vnd, item.size, item.qty]
      );
      const nextSizes = { ...item.product.sizes, [item.size]: Number(item.product.sizes[item.size]) - item.qty };
      await client.query('UPDATE products SET sizes=$1::jsonb,updated_at=NOW() WHERE id=$2', [JSON.stringify(nextSizes), item.product.id]);
    }
    await client.query('COMMIT');
    return res.status(201).json({ success: true, orderId: String(orderId), orderNumber: `DK-${orderId}`, total });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status) return res.status(e.status).json({ message: e.message });
    return fail(res, e);
  } finally {
    client.release();
  }
});

app.get('/api/v1/admin/orders', auth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, COALESCE(json_agg(json_build_object('name',i.product_name,'size',i.size,'quantity',i.quantity,'unitPrice',i.unit_price_vnd) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS items
       FROM orders o LEFT JOIN order_items i ON i.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 200`
    );
    res.json({ orders: rows });
  } catch (e) { fail(res, e); }
});

app.patch('/api/v1/admin/orders/:id/status', auth, async (req, res) => {
  const allowed = ['pending', 'confirmed', 'shipping', 'completed', 'cancelled'];
  const status = String(req.body?.status || '');
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || !allowed.includes(status)) return res.status(400).json({ message: 'Mã đơn hoặc trạng thái không hợp lệ.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id,status FROM orders WHERE id=$1 FOR UPDATE', [id]);
    if (!existing.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' }); }
    const oldStatus = existing.rows[0].status;
    if (oldStatus === 'cancelled' && status !== 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Đơn đã hủy không thể mở lại; vui lòng tạo đơn mới.' });
    }
    if (status === 'cancelled' && oldStatus !== 'cancelled') {
      const items = await client.query('SELECT product_id,size,quantity FROM order_items WHERE order_id=$1 AND product_id IS NOT NULL', [id]);
      for (const item of items.rows) {
        const product = await client.query('SELECT sizes FROM products WHERE id=$1 FOR UPDATE', [item.product_id]);
        if (product.rows.length) {
          const sizes = { ...product.rows[0].sizes, [item.size]: Number(product.rows[0].sizes?.[item.size] || 0) + Number(item.quantity) };
          await client.query('UPDATE products SET sizes=$1::jsonb,updated_at=NOW() WHERE id=$2', [JSON.stringify(sizes), item.product_id]);
        }
      }
    }
    const updated = await client.query('UPDATE orders SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING id,status', [status,id]);
    await client.query('COMMIT');
    return res.json({ order: updated.rows[0] });
  } catch (e) { await client.query('ROLLBACK'); return fail(res,e); }
  finally { client.release(); }
});

app.listen(port, () => {
  console.log(`DK FASHION API listening on ${port}`);
});
