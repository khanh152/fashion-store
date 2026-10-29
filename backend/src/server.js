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
| Giữ các bảo vệ mặc định của Helmet.
| Cho phép inline script/style hiện có trong admin.html.
| Lâu dài nên chuyển inline script sang file JS riêng hoặc dùng nonce/hash.
*/

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),

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

app.listen(port, () => {
  console.log(`DK FASHION API listening on ${port}`);
});
