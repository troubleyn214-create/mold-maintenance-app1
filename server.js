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
    CREATE TABLE IF NOT EXISTS shot_molds (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS shot_records (
      id BIGSERIAL PRIMARY KEY,
      mold_id BIGINT NOT NULL REFERENCES shot_molds(id) ON DELETE CASCADE,
      recorded_on DATE NOT NULL,
      shot_count BIGINT NOT NULL CHECK (shot_count > 0),
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS shot_records_mold_id_idx
      ON shot_records (mold_id, recorded_on DESC, id DESC);
  `);
}

function publicBaseUrl(req) {
  const configuredUrl = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (configuredUrl) return configuredUrl.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function parsePositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

app.use(express.json({ limit: '32kb' }));
app.use('/vendor/html5-qrcode', express.static(path.join(__dirname, 'node_modules', 'html5-qrcode', 'minified')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/molds', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.name, m.created_at,
             COALESCE(SUM(r.shot_count), 0)::text AS total_shots,
             MAX(r.recorded_on) AS last_recorded_on
      FROM shot_molds m
      LEFT JOIN shot_records r ON r.mold_id = m.id
      GROUP BY m.id
      ORDER BY m.id DESC
    `);
    res.json(rows);
  } catch (error) { next(error); }
});

app.post('/api/molds', async (req, res, next) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 100) {
    return res.status(400).json({ error: '金型名称を100文字以内で入力してください。' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO shot_molds (name) VALUES ($1) RETURNING id, name, created_at', [name]
    );
    res.status(201).json(rows[0]);
  } catch (error) { next(error); }
});

app.get('/api/molds/:id', async (req, res, next) => {
  try {
    const moldResult = await pool.query(`
      SELECT m.id, m.name, m.created_at,
             COALESCE(SUM(r.shot_count), 0)::text AS total_shots
      FROM shot_molds m
      LEFT JOIN shot_records r ON r.mold_id = m.id
      WHERE m.id = $1
      GROUP BY m.id
    `, [req.params.id]);
    if (!moldResult.rowCount) return res.status(404).json({ error: '金型が見つかりません。' });

    const recordsResult = await pool.query(`
      SELECT id, recorded_on, shot_count::text, notes, created_at
      FROM shot_records
      WHERE mold_id = $1
      ORDER BY recorded_on DESC, id DESC
    `, [req.params.id]);
    res.json({ ...moldResult.rows[0], records: recordsResult.rows });
  } catch (error) { next(error); }
});

app.post('/api/molds/:id/shots', async (req, res, next) => {
  const recordedOn = String(req.body.recordedOn || '').trim();
  const shotCount = parsePositiveInteger(req.body.shotCount);
  const notes = String(req.body.notes || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recordedOn) || shotCount === null || notes.length > 500) {
    return res.status(400).json({ error: '日付・今回ショット数・メモを正しく入力してください。' });
  }
  try {
    const { rows } = await pool.query(`
      INSERT INTO shot_records (mold_id, recorded_on, shot_count, notes)
      VALUES ($1, $2, $3, $4)
      RETURNING id, recorded_on, shot_count::text, notes, created_at
    `, [req.params.id, recordedOn, shotCount, notes]);
    res.status(201).json(rows[0]);
  } catch (error) {
    if (error.code === '23503') return res.status(404).json({ error: '金型が見つかりません。' });
    next(error);
  }
});

app.get('/api/molds/:id/qr', async (req, res, next) => {
  try {
    const moldResult = await pool.query('SELECT id FROM shot_molds WHERE id = $1', [req.params.id]);
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

if (require.main === module) {
  initializeDatabase()
    .then(() => app.listen(port, '0.0.0.0', () => console.log(`ショット数管理アプリを起動しました: ${port}`)))
    .catch((error) => {
      console.error('データベースの準備に失敗しました。', error);
      process.exit(1);
    });
}

module.exports = { app, initializeDatabase, parsePositiveInteger };
