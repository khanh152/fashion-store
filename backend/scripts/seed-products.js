import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const TARGET = 12;
const audiences = ['Nam', 'Nữ', 'Trẻ em'];
const catalog = {
  'Giày': { price: 1290000, sizes: ['36','37','38','39','40','41','42','43'], names: ['Runner Mesh','Court Classic','Urban Low','Flex Trainer','Daily Knit','Trail Grip','Retro Court','Lite Pace','Street Cup','Cloud Walk','Active Pro','Minimal Low'], photos: ['photo-1542291026-7eec264c27ff','photo-1543163521-1bf539c55dd2','photo-1608231387042-66d1773070a5','photo-1552346154-21d32810aba3','photo-1600185365483-26d7a4cc7519','photo-1495555961986-6d4c1ecb7be3'] },
  'Dép': { price: 390000, sizes: ['36','37','38','39','40','41','42'], names: ['Slide Comfort','Quai Ngang','Cloud Slide','Active Sandal','Quai Hậu','Easy Day','Sport Slide','Soft Walk','Urban Sandal','Lite Strap','Pool Essential','Daily Slide'], photos: ['photo-1562273138-f46be4ebdf33','photo-1603487742131-4160ec999306','photo-1543163521-1bf539c55dd2','photo-1600185365483-26d7a4cc7519','photo-1552346154-21d32810aba3','photo-1495555961986-6d4c1ecb7be3'] },
  'Quần': { price: 690000, sizes: ['XS','S','M','L','XL'], names: ['Jogger Năng Động','Cargo Street','Chino Everyday','Short Active','Denim Relaxed','Track Pant','Tapered Fit','Utility Cargo','Short Lifestyle','Straight Denim','Training Flex','Easy Trousers'], photos: ['photo-1515886657613-9f3515b0c78f','photo-1529139574466-a303027c1d8b','photo-1539109136881-3be0616acf4b','photo-1483985988355-763728e1935b','photo-1490481651871-ab68de25d43d','photo-1525507119028-ed4c629a60a3'] },
  'Áo': { price: 490000, sizes: ['XS','S','M','L','XL'], names: ['T-shirt Essential','Thun Graphic','Polo Modern','Hoodie Street','Sweatshirt Core','Tank Top Active','Khoác Wind','T-shirt Oversize','Polo Sport','Áo Nỉ Everyday','Jersey Training','Zip Hoodie'], photos: ['photo-1521572163474-6864f9cf17ab','photo-1515886657613-9f3515b0c78f','photo-1529139574466-a303027c1d8b','photo-1539109136881-3be0616acf4b','photo-1483985988355-763728e1935b','photo-1525507119028-ed4c629a60a3'] },
  'Váy': { price: 790000, sizes: ['XS','S','M','L','XL'], names: ['Midi Everyday','Suông Modern','Hoa Lifestyle','Tennis Active','Sơ Mi Chic','Maxi Weekend','Knit Minimal','Denim Street','Thể Thao','A-line Classic','Layer Urban','Cotton Soft'], photos: ['photo-1539109136881-3be0616acf4b','photo-1490481651871-ab68de25d43d','photo-1515886657613-9f3515b0c78f','photo-1483985988355-763728e1935b','photo-1529139574466-a303027c1d8b','photo-1525507119028-ed4c629a60a3'] },
  'Phụ kiện': { price: 290000, sizes: ['One Size'], names: ['Túi Đeo Chéo Daily','Balo Urban','Tất Sport Crew','Mũ Lưỡi Trai Core','Túi Tote Lifestyle','Thắt Lưng Canvas','Ví Gọn Nhẹ','Nón Bucket Street','Túi Gym Active','Tất Cổ Thấp','Khăn Choàng Soft','Belt Bag Mini'], photos: ['photo-1584917865442-de89df76afd3','photo-1553062407-98eeb64c6a62','photo-1523381210434-271e8be1f52b','photo-1529139574466-a303027c1d8b','photo-1490481651871-ab68de25d43d','photo-1483985988355-763728e1935b'] },
};

const groupsFor = (audience) => audience === 'Nữ' ? Object.keys(catalog) : Object.keys(catalog).filter((category) => category !== 'Váy');
const sizesFor = (audience, category, defaults) => {
  if (audience !== 'Trẻ em') return defaults;
  if (category === 'Giày' || category === 'Dép') return ['28','29','30','31','32','33','34','35'];
  if (category === 'Phụ kiện') return ['One Size'];
  return ['100','110','120','130','140','150'];
};
const imageUrl = (id) => `https://images.unsplash.com/${id}?fit=crop&w=720&h=900&q=55&fm=jpg`;

async function loadImage(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Tải ảnh lỗi HTTP ${response.status}: ${url}`);
  const mime = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  if (!['image/jpeg','image/png','image/webp'].includes(mime)) throw new Error(`Ảnh không đúng định dạng JPEG/PNG/WEBP: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 480000) throw new Error(`Ảnh rỗng hoặc quá lớn (${bytes.length} bytes): ${url}`);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Thiếu DATABASE_URL. Tạo backend/.env theo .env.example.');
  const columns = await pool.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'products'`
  );
  const actualTypes = new Map(columns.rows.map((column) => [column.column_name, column.data_type]));
  const requiredTypes = {
    name: 'text',
    price_vnd: 'integer',
    category: 'text',
    audience: 'text',
    description: 'text',
    image_data_url: 'text',
    sizes: 'jsonb',
    active: 'boolean',
  };
  const mismatches = Object.entries(requiredTypes)
    .filter(([name, type]) => actualTypes.get(name) !== type)
    .map(([name, type]) => `${name} requires ${type}; found ${actualTypes.get(name) || 'missing'}`);
  if (mismatches.length) {
    throw new Error(`products schema incompatible; no data written: ${mismatches.join('; ')}`);
  }

  const initial = await pool.query('SELECT audience,category,COUNT(*)::int AS count FROM products WHERE active=TRUE GROUP BY audience,category');
  const getCount = (rows, audience, category) => Number(rows.find((r) => r.audience === audience && r.category === category)?.count || 0);

  // Download and validate every needed image before opening the write transaction.
  const images = new Map();
  for (const audience of audiences) for (const category of groupsFor(audience)) {
    if (getCount(initial.rows, audience, category) >= TARGET) continue;
    for (const photo of catalog[category].photos) {
      const url = imageUrl(photo);
      if (!images.has(url)) images.set(url, await loadImage(url));
    }
  }

  const client = await pool.connect();
  let totalAdded = 0;
  const report = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('dk-fashion-catalog-seed-v1'))");
    const { rows } = await client.query('SELECT audience,category,COUNT(*)::int AS count FROM products WHERE active=TRUE GROUP BY audience,category');
    for (const audience of audiences) for (const category of groupsFor(audience)) {
      const item = catalog[category];
      const before = getCount(rows, audience, category);
      const needed = Math.max(0, TARGET - before);
      let added = 0;
      for (let i = 0; i < needed; i++) {
        const baseName = `${category} ${audience} ${item.names[i]} ${String(i + 1).padStart(2, '0')}`;
        let name = baseName;
        let suffix = 1;
        while ((await client.query('SELECT 1 FROM products WHERE name=$1 LIMIT 1', [name])).rowCount) {
          suffix++;
          name = `${baseName} Edition ${suffix}`;
        }
        const sizes = Object.fromEntries(sizesFor(audience, category, item.sizes).map((size, j) => [size, (j + i) % 5 + 1]));
        const photo = item.photos[i % item.photos.length];
        const result = await client.query(
          `INSERT INTO products (name,price_vnd,category,audience,description,image_data_url,sizes)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
           RETURNING id`,
          [name, item.price + (i % 4) * 100000, category, audience,
            `Thiết kế ${item.names[i].toLowerCase()} dành cho ${audience.toLowerCase()}, phù hợp phong cách thời trang năng động hằng ngày.`,
            images.get(imageUrl(photo)), JSON.stringify(sizes)]
        );
        if (result.rowCount) { added++; totalAdded++; }
      }
      report.push(`${audience} | ${category}: ${before} trước, +${added}, ${before + added} sau`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  console.log(`Đã thêm ${totalAdded} sản phẩm. Không cập nhật hoặc xóa dữ liệu cũ.`);
  report.forEach((line) => console.log(line));
}

main().catch((error) => {
  console.error(`Seed dừng trước khi xác nhận hoàn tất: ${error.message}`);
  process.exitCode = 1;
}).finally(() => pool.end());
