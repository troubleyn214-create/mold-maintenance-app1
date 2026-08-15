const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const path = require('path');

const SESSION_COOKIE = 'shot_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function parsePositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim();
  return configured ? configured.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
}

function createApp({ pool, secureCookies = process.env.NODE_ENV === 'production', now = () => new Date(), loginMaxAttempts = LOGIN_MAX_ATTEMPTS, loginWindowMs = LOGIN_WINDOW_MS }) {
  if (!pool) throw new Error('pool is required');
  const app = express();
  const loginAttempts = new Map();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));

  async function cleanupExpiredSessions() {
    await pool.query('DELETE FROM auth_sessions WHERE expires_at <= $1::timestamptz', [now()]);
  }
  function rateState(req, email) {
    const key = `${req.ip}|${email}`;
    const time = now().getTime();
    let state = loginAttempts.get(key);
    if (!state || state.resetAt <= time) {
      state = { count: 0, resetAt: time + loginWindowMs };
      loginAttempts.set(key, state);
    }
    return { key, state, time };
  }
  async function loadSession(req, res, next) {
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!token) return next();
      const { rows } = await pool.query(`
        SELECT s.id AS session_id,s.csrf_token_hash,u.id AS user_id,u.email,m.company_id,m.role
        FROM auth_sessions s
        JOIN users u ON u.id=s.user_id AND u.status='active'
        JOIN memberships m ON m.user_id=u.id
        JOIN companies c ON c.id=m.company_id AND c.status='active'
        WHERE s.token_hash=$1 AND s.expires_at>$2::timestamptz
      `, [tokenHash(token), now()]);
      if (rows.length === 1) req.auth = rows[0];
      next();
    } catch (error) { next(error); }
  }
  function requireAuth(req, res, next) {
    if (!req.auth) return res.status(401).json({ error: 'ログインが必要です。', code: 'AUTH_REQUIRED' });
    next();
  }
  function requireCsrf(req, res, next) {
    const csrf = String(req.get('x-csrf-token') || '');
    if (!csrf || !req.auth || tokenHash(csrf) !== req.auth.csrf_token_hash) {
      return res.status(403).json({ error: '画面の有効期限が切れました。再読み込みしてください。', code: 'CSRF_INVALID' });
    }
    next();
  }

  app.get('/api/health', async (req, res, next) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'ok' }); } catch (error) { next(error); }
  });
  app.post('/api/auth/login', async (req, res, next) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    try {
      const rate = rateState(req, email);
      if (rate.state.count >= loginMaxAttempts) {
        res.set('Retry-After', String(Math.ceil((rate.state.resetAt - rate.time) / 1000)));
        return res.status(429).json({ error: 'ログイン試行が多すぎます。しばらく待ってから再度お試しください。', code: 'LOGIN_RATE_LIMITED' });
      }
      const { rows } = await pool.query(`
        SELECT u.id,u.email,u.password_hash,m.company_id,m.role
        FROM users u JOIN memberships m ON m.user_id=u.id JOIN companies c ON c.id=m.company_id
        WHERE u.email=$1 AND u.status='active' AND c.status='active'
      `, [email]);
      if (rows.length !== 1 || !(await bcrypt.compare(password, rows[0].password_hash))) {
        rate.state.count += 1;
        return res.status(401).json({ error: 'メールアドレスまたはパスワードが違います。', code: 'LOGIN_FAILED' });
      }
      loginAttempts.delete(rate.key);
      await cleanupExpiredSessions();
      const token = crypto.randomBytes(32).toString('base64url');
      const csrfToken = crypto.randomBytes(32).toString('base64url');
      await pool.query('INSERT INTO auth_sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,$4::timestamptz)', [rows[0].id, tokenHash(token), tokenHash(csrfToken), new Date(now().getTime() + SESSION_TTL_MS)]);
      res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: SESSION_TTL_MS, path: '/' });
      res.json({ csrfToken, user: { id: rows[0].id, email: rows[0].email, companyId: rows[0].company_id, role: rows[0].role } });
    } catch (error) { next(error); }
  });
  app.get('/api/auth/session', loadSession, requireAuth, (req, res) => res.json({ user: { id: req.auth.user_id, email: req.auth.email, companyId: req.auth.company_id, role: req.auth.role } }));
  app.post('/api/auth/logout', loadSession, requireAuth, requireCsrf, async (req, res, next) => {
    try {
      await pool.query('DELETE FROM auth_sessions WHERE id=$1', [req.auth.session_id]);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.use('/api/molds', loadSession, requireAuth);
  app.use('/api/molds', (req, res, next) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? next() : requireCsrf(req, res, next));
  app.get('/api/molds', async (req, res, next) => {
    try {
      const { rows } = await pool.query(`SELECT m.id,m.name,m.created_at,COALESCE(SUM(r.shot_count),0)::text AS total_shots,MAX(r.recorded_on) AS last_recorded_on FROM shot_molds m LEFT JOIN shot_records r ON r.mold_id=m.id AND r.company_id=m.company_id WHERE m.company_id=$1 GROUP BY m.id,m.name,m.created_at ORDER BY m.id DESC`, [req.auth.company_id]);
      res.json(rows);
    } catch (error) { next(error); }
  });
  app.post('/api/molds', async (req, res, next) => {
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 100) return res.status(400).json({ error: '金型名称を100文字以内で入力してください。' });
    try {
      const { rows } = await pool.query('INSERT INTO shot_molds(company_id,name) VALUES($1,$2) RETURNING id,name,created_at', [req.auth.company_id, name]);
      res.status(201).json(rows[0]);
    } catch (error) { next(error); }
  });
  app.get('/api/molds/:id', async (req, res, next) => {
    try {
      const mold = await pool.query(`SELECT m.id,m.name,m.created_at,COALESCE(SUM(r.shot_count),0)::text AS total_shots FROM shot_molds m LEFT JOIN shot_records r ON r.mold_id=m.id AND r.company_id=m.company_id WHERE m.id=$1 AND m.company_id=$2 GROUP BY m.id,m.name,m.created_at`, [req.params.id, req.auth.company_id]);
      if (!mold.rowCount) return res.status(404).json({ error: '金型が見つかりません。' });
      const records = await pool.query('SELECT id,recorded_on,shot_count::text,notes,created_at FROM shot_records WHERE mold_id=$1 AND company_id=$2 ORDER BY recorded_on DESC,id DESC', [req.params.id, req.auth.company_id]);
      res.json({ ...mold.rows[0], records: records.rows });
    } catch (error) { next(error); }
  });
  app.post('/api/molds/:id/shots', async (req, res, next) => {
    const recordedOn = String(req.body.recordedOn || '').trim();
    const counterValue = parsePositiveInteger(req.body.counterValue);
    const idempotencyKey = String(req.get('x-idempotency-key') || '').trim();
    const notes = String(req.body.notes || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(recordedOn) || counterValue === null || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey) || notes.length > 500) {
      return res.status(400).json({ error: '日付・金型カウンターの累計値・メモを正しく入力してください。' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const duplicate = await client.query('SELECT id,mold_id,recorded_on,shot_count::text,counter_value::text,notes,created_at FROM shot_records WHERE company_id=$1 AND idempotency_key=$2', [req.auth.company_id, idempotencyKey]);
      if (duplicate.rowCount) {
        await client.query('COMMIT');
        if (String(duplicate.rows[0].mold_id) !== String(req.params.id)) return res.status(409).json({ error: '同じ送信IDが別の金型で使用されています。' });
        return res.status(200).json({ ...duplicate.rows[0], duplicate: true });
      }
      const mold = await client.query('SELECT id FROM shot_molds WHERE id=$1 AND company_id=$2 FOR UPDATE', [req.params.id, req.auth.company_id]);
      if (!mold.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: '金型が見つかりません。' });
      }
      const totalResult = await client.query('SELECT COALESCE(SUM(shot_count),0)::text AS total_shots FROM shot_records WHERE mold_id=$1 AND company_id=$2', [req.params.id, req.auth.company_id]);
      const currentTotal = Number(totalResult.rows[0].total_shots);
      if (!Number.isSafeInteger(currentTotal) || counterValue <= currentTotal) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `累計値は現在値 ${currentTotal.toLocaleString('ja-JP')} より大きい値を入力してください。`, code: 'COUNTER_NOT_ADVANCED', currentTotal });
      }
      const shotCount = counterValue - currentTotal;
      const { rows } = await client.query('INSERT INTO shot_records(company_id,mold_id,created_by_user_id,recorded_on,shot_count,counter_value,idempotency_key,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,recorded_on,shot_count::text,counter_value::text,notes,created_at', [req.auth.company_id, req.params.id, req.auth.user_id, recordedOn, shotCount, counterValue, idempotencyKey, notes]);
      await client.query('COMMIT');
      res.status(201).json(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  });
  app.get('/api/molds/:id/qr', async (req, res, next) => {
    try {
      const mold = await pool.query('SELECT id FROM shot_molds WHERE id=$1 AND company_id=$2', [req.params.id, req.auth.company_id]);
      if (!mold.rowCount) return res.status(404).json({ error: '金型が見つかりません。' });
      const url = `${publicBaseUrl(req)}/molds/${mold.rows[0].id}`;
      res.json({ url, dataUrl: await QRCode.toDataURL(url, { width: 720, margin: 2, errorCorrectionLevel: 'M' }) });
    } catch (error) { next(error); }
  });

  app.use('/vendor/html5-qrcode', express.static(path.join(__dirname, 'node_modules', 'html5-qrcode')));
  app.use(express.static(path.join(__dirname, 'public')));
  app.get(['/molds/:id', '/scan', '/login'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.use((error, req, res, next) => { console.error(error); res.status(500).json({ error: '処理に失敗しました。もう一度お試しください。' }); });
  return app;
}

function createProductionPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL を設定してください。');
  const ssl = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
  return new Pool({ connectionString: process.env.DATABASE_URL, ssl });
}
if (require.main === module) {
  const pool = createProductionPool();
  const port = process.env.PORT || 3000;
  const cleanup = setInterval(() => pool.query('DELETE FROM auth_sessions WHERE expires_at<=CURRENT_TIMESTAMP').catch(console.error), 60 * 60 * 1000);
  cleanup.unref();
  createApp({ pool }).listen(port, '0.0.0.0', () => console.log(`ショット数管理アプリを起動しました: ${port}`));
}
module.exports = { createApp, parsePositiveInteger, tokenHash };
