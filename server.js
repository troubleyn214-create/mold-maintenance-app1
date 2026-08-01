const express = require('express');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const path = require('path');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL を設定してください。');
}

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.set('trust proxy', 1);

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS molds (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS maintenance_logs (
      id BIGSERIAL PRIMARY KEY,
      mold_id BIGINT NOT NULL REFERENCES molds(id) ON DELETE CASCADE,
      performed_on DATE NOT NULL,
      details TEXT NOT NULL,
      shot_count BIGINT NOT NULL CHECK (shot_count >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function publicBaseUrl(req) {
  const configuredUrl = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (configuredUrl) return configuredUrl.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

app.use(express.json());
app.use('/vendor/html5-qrcode', express.static(path.join(__dirname, 'node_modules', 'html5-qrcode', 'minified')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/molds', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, name, created_at FROM molds ORDER BY id DESC');
    res.json(rows);
  } catch (error) { next(error); }
});

app.post('/api/molds', async (req, res, next) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '金型名称を入力してください。' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO molds (name) VALUES ($1) RETURNING id, name, created_at', [name]
    );
    res.status(201).json(rows[0]);
  } catch (error) { next(error); }
});

app.get('/api/molds/:id', async (req, res, next) => {
  try {
    const moldResult = await pool.query('SELECT id, name, created_at FROM molds WHERE id = $1', [req.params.id]);
    if (!moldResult.rowCount) return res.status(404).json({ error: '金型が見つかりません。' });
    const logsResult = await pool.query(
      `SELECT id, performed_on, details, shot_count, created_at
       FROM maintenance_logs WHERE mold_id = $1 ORDER BY performed_on DESC, id DESC`, [req.params.id]
    );
    res.json({ ...moldResult.rows[0], logs: logsResult.rows });
  } catch (error) { next(error); }
});

app.post('/api/molds/:id/logs', async (req, res, next) => {
  const performedOn = String(req.body.performedOn || '').trim();
  const details = String(req.body.details || '').trim();
  const shotCount = Number(req.body.shotCount);
  if (!performedOn || !details || !Number.isSafeInteger(shotCount) || shotCount < 0) {
    return res.status(400).json({ error: '実施日・内容・ショット数を正しく入力してください。' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO maintenance_logs (mold_id, performed_on, details, shot_count)
       VALUES ($1, $2, $3, $4)
       RETURNING id, performed_on, details, shot_count, created_at`,
      [req.params.id, performedOn, details, shotCount]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    if (error.code === '23503') return res.status(404).json({ error: '金型が見つかりません。' });
    next(error);
  }
});

app.get('/api/molds/:id/qr', async (req, res, next) => {
  try {
    const moldResult = await pool.query('SELECT id FROM molds WHERE id = $1', [req.params.id]);
    if (!moldResult.rowCount) return res.status(404).json({ error: '金型が見つかりません。' });
    const url = `${publicBaseUrl(req)}/molds/${moldResult.rows[0].id}`;
    const dataUrl = await QRCode.toDataURL(url, { width: 720, margin: 2, errorCorrectionLevel: 'M' });
    res.json({ url, dataUrl });
  } catch (error) { next(error); }
});

app.get(['/molds/:id', '/scan'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: '処理に失敗しました。もう一度お試しください。' });
});

initializeDatabase()
  .then(() => app.listen(port, '0.0.0.0', () => console.log(`金型管理アプリを起動しました: ${port}`)))
  .catch((error) => {
    console.error('データベースの準備に失敗しました。', error);
    process.exit(1);
  });
