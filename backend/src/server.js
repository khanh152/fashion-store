
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
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 15000,
  query_timeout: 20000,
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

function isLocalDevelopmentOrigin(origin) {
  try {
    const url = new URL(origin);
    return (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

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
      if (
        !origin ||
        origins.includes(origin) ||
        isLocalDevelopmentOrigin(origin)
      ) {
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

  category: z.string().trim().min(1).max(80),

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
  active: r.active,

  stock: Object.values(r.sizes || {}).reduce(
    (a, n) => a + Number(n || 0),
    0
  ),

  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const publicProductShape = (r) => ({
  id: String(r.id),
  title: r.name,
  name: r.name,
  price: r.price_vnd,
  category: r.category,
  audience: r.audience,
  description: r.description,
  imageUrl: `/api/v1/products/${r.id}/image?v=${encodeURIComponent(
    new Date(r.updated_at).toISOString()
  )}`,
  sizes: r.sizes,
  active: r.active,
  stock: Object.values(r.sizes || {}).reduce(
    (total, quantity) => total + Number(quantity || 0),
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

async function sendProductImage(id, res, includeInactive = false) {
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ message: 'Mã sản phẩm không hợp lệ.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT image_data_url FROM products WHERE id=$1${includeInactive ? '' : ' AND active=TRUE'}`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ message: 'Không tìm thấy ảnh sản phẩm.' });
    }

    const match =
      /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
        rows[0].image_data_url
      );
    if (!match) {
      return res.status(500).json({ message: 'Ảnh sản phẩm không hợp lệ.' });
    }

    const contentType = `image/${match[1].toLowerCase()}`;
    res
      .set(
        'Cache-Control',
        includeInactive
          ? 'private, max-age=300'
          : 'public, max-age=31536000, immutable'
      )
      .type(contentType)
      .send(Buffer.from(match[2], 'base64'));
  } catch (e) {
    return fail(res, e);
  }
}

app.get('/api/v1/products/:id/image', (req, res) =>
  sendProductImage(Number(req.params.id), res)
);

app.get('/api/v1/admin/products/:id/image', auth, (req, res) =>
  sendProductImage(Number(req.params.id), res, true)
);

app.get('/api/v1/products', async (req, res) => {
  const page = Number(req.query.page || 1);
  const pageSize = Number(req.query.limit || 12);
  const search = String(req.query.q || '').trim();
  const audience = String(req.query.audience || 'all');
  const category = String(req.query.category || 'all');
  const department = String(req.query.department || 'all');
  const normalizedCategory = category
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .trim()
    .toLowerCase();
  const categoryAliases = {
    all: 'all',
    'tat ca': 'all',
    giay: 'shoes',
    dep: 'sandals',
    quan: 'pants',
    ao: 'tops',
    vay: 'dresses',
    'phu kien': 'accessories',
  };
  const categoryKey = Object.hasOwn(categoryAliases, normalizedCategory)
    ? categoryAliases[normalizedCategory]
    : normalizedCategory;
  const sort = String(req.query.sort || 'default');

  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    search.length > 100 ||
    !['all', 'nam', 'nu', 'tre-em'].includes(audience) ||
    !['all', 'sports'].includes(department) ||
    !['default', 'price-asc', 'price-desc'].includes(sort)
  ) {
    return res.status(400).json({
      message: 'Tham số phân trang hoặc bộ lọc không hợp lệ.',
    });
  }

  const filters = ['active=TRUE'];
  const values = [];
  const addFilter = (sql, value) => {
    values.push(value);
    filters.push(sql.replace('?', `$${values.length}`));
  };

  if (search) {
    addFilter(
      `POSITION(LOWER(?) IN LOWER(CONCAT_WS(' ',name,category,audience))) > 0`,
      search
    );
  }

  if (audience === 'nam') {
    filters.push(
      "(audience ILIKE '%nam%' OR audience ILIKE '%unisex%')"
    );
  } else if (audience === 'nu') {
    filters.push(
      "(audience ILIKE '%nữ%' OR audience ILIKE '%nu%' OR audience ILIKE '%unisex%')"
    );
  } else if (audience === 'tre-em') {
    filters.push(
      "(audience ILIKE '%trẻ em%' OR audience ILIKE '%tre em%' OR audience ILIKE '%children%' OR audience ILIKE '%kids%')"
    );
  }

  if (department === 'sports') {
    filters.push(
      `(category ILIKE 'Thể thao - %' OR LOWER(category)=ANY(ARRAY['chạy bộ','lifestyle','giá tốt','training','originals']::text[]))`
    );
  }

  const productTypes = {
    shoes: {
      categories: ['giày', 'giay', 'shoe', 'shoes'],
      categoryPatterns: ['%giày%', '%giay%', '%shoe%'],
      names: ['%giày%', '%giay%', '%shoe%', '%sneaker%', '%boot%'],
    },
    sandals: {
      categories: ['dép', 'dep', 'sandal', 'sandals'],
      categoryPatterns: ['%dép%', '%dep%', '%sandal%'],
      names: ['%dép%', '%dep%', '%sandal%', '%flip flop%'],
    },
    pants: {
      categories: ['quần', 'quan', 'pants', 'trouser', 'trousers', 'jeans'],
      categoryPatterns: ['%quần%', '%quan%', '%pant%', '%jean%'],
      names: ['%quần%', '%quan%', '%pants%', '%trouser%', '%jeans%'],
    },
    tops: {
      categories: ['áo', 'ao', 'shirt', 'shirts', 'top', 'tops'],
      categoryPatterns: ['%áo%', '%ao%', '%shirt%', '%top%'],
      names: ['%áo%', '%ao%', '%shirt%', '%top%', '%hoodie%', '%jacket%'],
    },
    dresses: {
      categories: ['váy', 'vay', 'dress', 'dresses', 'skirt', 'skirts'],
      categoryPatterns: ['%váy%', '%vay%', '%dress%', '%skirt%'],
      names: ['%váy%', '%vay%', '%dress%', '%skirt%'],
    },
    accessories: {
      categories: ['phụ kiện', 'phu kien', 'accessory', 'accessories'],
      categoryPatterns: ['%phụ kiện%', '%phu kien%', '%accessor%'],
      names: ['%phụ kiện%', '%phu kien%', '%accessory%', '%túi%', '%tui%', '%bag%', '%cap%', '%hat%', '%socks%'],
    },
  };

  if (productTypes[categoryKey]) {
    const type = productTypes[categoryKey];
    values.push(type.categories);
    const categoryParam = `$${values.length}`;
    values.push(type.categoryPatterns);
    const categoryPatternParam = `$${values.length}`;
    values.push(type.names);
    const nameParam = `$${values.length}`;
    filters.push(
      `(LOWER(category)=ANY(${categoryParam}::text[]) OR category ILIKE ANY(${categoryPatternParam}::text[]) OR name ILIKE ANY(${nameParam}::text[]))`
    );
  } else if (categoryKey !== 'all') {
    addFilter('LOWER(category)=LOWER(?)', category);
  }

  const where = filters.join(' AND ');
  const orderBy =
    sort === 'price-asc'
      ? 'price_vnd ASC,id DESC'
      : sort === 'price-desc'
        ? 'price_vnd DESC,id DESC'
        : 'updated_at DESC,id DESC';

  try {
    const limitParam = values.length + 1;
    const offsetParam = values.length + 2;
    const offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(offset)) {
      return res.status(400).json({ message: 'Số trang vượt quá giới hạn.' });
    }

    const { rows } = await pool.query(
      `SELECT id,name,price_vnd,category,audience,description,sizes,active,
              created_at,updated_at,COUNT(*) OVER() AS total_count
       FROM products
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...values, pageSize, offset]
    );
    let total = Number(rows[0]?.total_count || 0);
    if (!rows.length) {
      const count = await pool.query(
        `SELECT COUNT(*) AS total FROM products WHERE ${where}`,
        values
      );
      total = Number(count.rows[0].total);
    }

    res.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=30').json({
      products: rows.map(publicProductShape),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
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
  const page = Number(_q.query.page || 1);
  const pageSize = Number(_q.query.limit || 20);
  const search = String(_q.query.q || '').trim();
  const category = String(_q.query.category || '').trim();
  const audience = String(_q.query.audience || '').trim();

  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    search.length > 100 ||
    category.length > 80 ||
    audience.length > 40
  ) {
    return res.status(400).json({
      message: 'Tham số phân trang hoặc bộ lọc không hợp lệ.',
    });
  }

  const filters = [];
  const values = [];
  const addFilter = (sql, value) => {
    values.push(value);
    filters.push(sql.replace('?', `$${values.length}`));
  };
  if (search) {
    addFilter(
      `POSITION(LOWER(?) IN LOWER(name)) > 0`,
      search
    );
  }
  if (category) addFilter('category=?', category);
  if (audience) addFilter('audience=?', audience);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  try {
    const limitParam = values.length + 1;
    const offsetParam = values.length + 2;
    const offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(offset)) {
      return res.status(400).json({ message: 'Số trang vượt quá giới hạn.' });
    }

    const [result, categories, audiences, catalogCount] = await Promise.all([
      pool.query(
        `SELECT id,name,price_vnd,category,audience,description,sizes,active,
                created_at,updated_at,COUNT(*) OVER() AS total_count
         FROM products ${where}
         ORDER BY updated_at DESC,id DESC
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        [...values, pageSize, offset]
      ),
      pool.query('SELECT DISTINCT category FROM products ORDER BY category'),
      pool.query('SELECT DISTINCT audience FROM products ORDER BY audience'),
      pool.query('SELECT COUNT(*) AS total FROM products'),
    ]);

    let total = Number(result.rows[0]?.total_count || 0);
    if (!result.rows.length) {
      const count = await pool.query(
        `SELECT COUNT(*) AS total FROM products ${where}`,
        values
      );
      total = Number(count.rows[0].total);
    }

    res.set('Cache-Control', 'private, no-store').json({
      products: result.rows.map(publicProductShape).map(({ imageUrl, ...product }) => product),
      pagination: {
        page,
        pageSize,
        total,
        totalProducts: Number(catalogCount.rows[0].total),
        totalPages: Math.ceil(total / pageSize),
      },
      filters: {
        categories: categories.rows.map((row) => row.category).filter(Boolean),
        audiences: audiences.rows.map((row) => row.audience).filter(Boolean),
      },
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
      const available = Number(product.sizes?.[size] ?? 0);

      if (available < qty) {
        throw Object.assign(
          new Error(
            `Sản phẩm ${product.name} size ${size} không đủ tồn kho.`
          ),
          { status: 409 }
        );
      }

      total += Number(product.price_vnd) * qty;

      resolved.push({
        product,
        size,
        qty,
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
          item.product.price_vnd,
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
