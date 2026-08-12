const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const path = require('path');

const SESSION_COOKIE = 'shot_session';
const SESSION_TTL_DAYS = 7;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
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

function createApp({ pool, secureCookies = process.env.NODE_ENV === 'production' }) {
  if (!pool) throw new Error('pool is required');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));

  async function loadSession(req, res, next) {
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!token) return next();
      const { rows } = await pool.query(`
        SELECT s.id AS session_id, u.id AS user_id, u.email, m.company_id, m.role
        FROM auth_sessions s
        JOIN users u ON u.id = s.user_id AND u.status = 'active'
        JOIN memberships m ON m.user_id = u.id
        JOIN companies c ON c.id = m.company_id AND c.status = 'active'
        WHERE s.token_hash = $1 AND s.expires_at > $2::timestamptz
      `, [tokenHash(token), new Date()]);
      if (rows.length === 1) req.auth = rows[0];
      next();
    } catch (error) { next(error); }
  }

  function requireAuth(req, res, next) {
    if (!req.auth) return res.status(401).json({ error: 'ログインが必要です。' });
    next();
  }

  app.get('/api/health', async (req, res, next) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, database: 'ok' });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/login', async (req, res, next) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    try {
      const { rows } = await pool.query(`
        SELECT u.id, u.email, u.password_hash, m.company_id, m.role
        FROM users u
        JOIN memberships m ON m.user_id = u.id
        JOIN companies c ON c.id = m.company_id
        WHERE u.email = $1 AND u.status = 'active' AND c.status = 'active'
      `, [email]);
      if (rows.length !== 1 || !(await bcrypt.compare(password, rows[0].password_hash))) {
        return res.status(401).json({ error: 'メールアドレスまたはパスワードが違います。' });
      }
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query(`
        INSERT INTO auth_sessions (user_id, token_hash, expires_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '${SESSION_TTL_DAYS} days')
      `, [rows[0].id, tokenHash(token)]);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true, sameSite: 'lax', secure: secureCookies,
        maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000, path: '/'
      });
      res.json({ user: { id: rows[0].id, email: rows[0].email, companyId: rows[0].company_id, role: rows[0].role } });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/logout', loadSession, async (req, res, next) => {
    try {
      if (req.auth) await pool.query('DELETE FROM auth_sessions WHERE id = $1', [req.auth.session_id]);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.use('/api/molds', loadSession, requireAuth);

  app.get('/api/molds', async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT m.id, m.name, m.created_at,
               COALESCE(SUM(r.shot_count), 0)::text AS total_shots,
               MAX(r.recorded_on) AS last_recorded_on
        FROM shot_molds m
        LEFT JOIN shot_records r ON r.mold_id = m.id AND r.company_id = m.company_id
        WHERE m.company_id = $1
        GROUP BY m.id, m.name, m.created_at
        ORDER BY m.id DESC
      `, [req.auth.company_id]);
      res.json(rows);
    } catch (error) { next(error); }
  });

  app.post('/api/molds', async (req, res, next) => {
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 100) return res.status(400).json({ error: '金型名称を100文字以内で入力してください。' });
    try {
      const { rows } = await pool.query(
        'INSERT INTO shot_molds (company_id, name) VALUES ($1, $2) RETURNING id, name, created_at',
        [req.auth.company_id, name]
      );
      res.status(201).json(rows[0]);
    } catch (error) { next(error); }
  });

  app.get('/api/molds/:id', async (req, res, next) => {
    try {
      const moldResult = await pool.query(`
        SELECT m.id, m.name, m.created_at, COALESCE(SUM(r.shot_count), 0)::text AS total_shots
        FROM shot_molds m
        LEFT JOIN shot_records r ON r.mold_id = m.id AND r.company_id = m.company_id
        WHERE m.id = $1 AND m.company_id = $2
        GROUP BY m.id, m.name, m.created_at
      `, [req.params.id, req.auth.company_id]);
      if (!moldResult.rowCount) return res.status(404).json({ error: '金型が見つかりません。' });
      const recordsResult = await pool.query(`
        SELECT id, recorded_on, shot_count::text, notes, created_at
        FROM shot_records WHERE mold_id = $1 AND company_id = $2
        ORDER BY recorded_on DESC, id DESC
      `, [req.params.id, req.auth.company_id]);
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
      const moldResult = await pool.query(
        'SELECT id FROM shot_molds WHERE id = $1 AND company_id = $2',
        [req.params.id, req.auth.company_id]
      );
      if (!moldResult.rowCount) return res.status(404).json({ error: '金型が見つかりません。' });
      const { rows } = await pool.query(`
        INSERT INTO shot_records (company_id, mold_id, created_by_user_id, recorded_on, shot_count, notes)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, recorded_on, shot_count::text, notes, created_at
      `, [req.auth.company_id, req.params.id, req.auth.user_id, recordedOn, shotCount, notes]);
      res.status(201).json(rows[0]);
    } catch (error) { next(error); }
  });

  app.get('/api/molds/:id/qr', async (req, res, next) => {
    try {
      const moldResult = await pool.query(
        'SELECT id FROM shot_molds WHERE id = $1 AND company_id = $2',
        [req.params.id, req.auth.company_id]
      );
      if (!moldResult.rowCount) return res.status(404).json({ error: '金型が見つかりません。' });
      const url = `${publicBaseUrl(req)}/molds/${moldResult.rows[0].id}`;
      res.json({ url, dataUrl: await QRCode.toDataURL(url, { width: 720, margin: 2, errorCorrectionLevel: 'M' }) });
    } catch (error) { next(error); }
  });

  app.use('/vendor/html5-qrcode', express.static(path.join(__dirname, 'node_modules', 'html5-qrcode', 'minified')));
  app.use(express.static(path.join(__dirname, 'public')));
  app.get(['/molds/:id', '/scan'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ error: '処理に失敗しました。もう一度お試しください。' });
  });
  return app;
}

function createProductionPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL を設定してください。');
  return new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

if (require.main === module) {
  const pool = createProductionPool();
  const port = process.env.PORT || 3000;
  createApp({ pool }).listen(port, '0.0.0.0', () => console.log(`ショット数管理アプリを起動しました: ${port}`));
}

module.exports = { createApp, parsePositiveInteger, tokenHash };
