const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { newDb } = require('pg-mem');
const { createApp } = require('../server');
const { safeReturnPath } = require('../public/path-utils');

const legacySchema = `
  CREATE TABLE shot_molds (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE shot_records (
    id BIGSERIAL PRIMARY KEY,
    mold_id BIGINT NOT NULL REFERENCES shot_molds(id) ON DELETE CASCADE,
    recorded_on DATE NOT NULL,
    shot_count BIGINT NOT NULL CHECK (shot_count > 0),
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

async function setup() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.none(legacySchema);
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  const phase1 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_p0_nullable.sql'), 'utf8');
  await pool.query(phase1);
  await pool.query('ALTER TABLE shot_records ADD COLUMN counter_value BIGINT');
  await pool.query('ALTER TABLE shot_records ADD COLUMN idempotency_key TEXT');
  await pool.query('CREATE UNIQUE INDEX shot_records_company_idempotency_unique ON shot_records(company_id,idempotency_key)');
  await pool.query(`CREATE TABLE maintenance_records (
    id BIGSERIAL PRIMARY KEY, company_id BIGINT NOT NULL, mold_id BIGINT NOT NULL,
    created_by_user_id BIGINT NOT NULL, performed_on DATE NOT NULL,
    counter_value BIGINT NOT NULL, details TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const passwordHash = await bcrypt.hash('test-password', 4);
  const c1 = (await pool.query("INSERT INTO companies(name) VALUES('Alpha') RETURNING id")).rows[0].id;
  const c2 = (await pool.query("INSERT INTO companies(name) VALUES('Beta') RETURNING id")).rows[0].id;
  const u1 = (await pool.query("INSERT INTO users(email,password_hash) VALUES('alpha@example.test',$1) RETURNING id", [passwordHash])).rows[0].id;
  const u2 = (await pool.query("INSERT INTO users(email,password_hash) VALUES('beta@example.test',$1) RETURNING id", [passwordHash])).rows[0].id;
  const u3 = (await pool.query("INSERT INTO users(email,password_hash) VALUES('factory-floor-id',$1) RETURNING id", [passwordHash])).rows[0].id;
  await pool.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'admin'),($3,$4,'admin'),($1,$5,'member')", [c1, u1, c2, u2, u3]);
  const m1 = (await pool.query("INSERT INTO shot_molds(company_id,name) VALUES($1,'Alpha mold') RETURNING id", [c1])).rows[0].id;
  const m2 = (await pool.query("INSERT INTO shot_molds(company_id,name) VALUES($1,'Beta mold') RETURNING id", [c2])).rows[0].id;
  await pool.query("INSERT INTO shot_records(company_id,mold_id,created_by_user_id,recorded_on,shot_count) VALUES($1,$2,$3,'2026-08-01',100),($4,$5,$6,'2026-08-02',200)", [c1, m1, u1, c2, m2, u2]);
  return { pool, app: createApp({ pool, secureCookies: false }), ids: { c1, c2, u1, u2, u3, m1, m2 } };
}

async function login(agent, email) {
  const response = await agent.post('/api/auth/login').send({ email, password: 'test-password' });
  assert.equal(response.status, 200);
  return response.body.csrfToken;
}

test('unauthenticated mold reads and writes return 401', async () => {
  const { app, pool } = await setup();
  assert.equal((await request(app).get('/api/molds')).status, 401);
  assert.equal((await request(app).post('/api/molds').send({ name: 'blocked' })).status, 401);
  assert.equal((await request(app).post('/api/molds/1/shots').send({ recordedOn: '2026-08-13', counterValue: 1 })).status, 401);
  await pool.end();
});

test('QR scanner browser asset is served', async () => {
  const { app, pool } = await setup();
  const response = await request(app).get('/vendor/html5-qrcode/html5-qrcode.min.js');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /javascript/);
  await pool.end();
});

test('login ID is accepted without requiring an email address', async () => {
  const { app, pool } = await setup();
  const response = await request(app).post('/api/auth/login').send({ loginId: 'FACTORY-FLOOR-ID', password: 'test-password' });
  assert.equal(response.status, 200);
  assert.equal(response.body.user.email, 'factory-floor-id');
  await pool.end();
});

test('company member records maintenance at the current cumulative shot count', async () => {
  const { app, pool, ids } = await setup();
  const agent = request.agent(app);
  const csrf = await login(agent, 'alpha@example.test');
  const response = await agent.post(`/api/molds/${ids.m1}/maintenances`).set('X-CSRF-Token', csrf).send({ performedOn: '2026-08-18', details: '分解清掃とグリスアップ' });
  assert.equal(response.status, 201);
  assert.equal(response.body.counter_value, '100');
  const detail = await agent.get(`/api/molds/${ids.m1}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.maintenances[0].details, '分解清掃とグリスアップ');
  await pool.end();
});

test('maintenance records cannot be created for another company mold', async () => {
  const { app, pool, ids } = await setup();
  const agent = request.agent(app);
  const csrf = await login(agent, 'alpha@example.test');
  const response = await agent.post(`/api/molds/${ids.m2}/maintenances`).set('X-CSRF-Token', csrf).send({ performedOn: '2026-08-18', details: 'blocked' });
  assert.equal(response.status, 404);
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS n FROM maintenance_records')).rows[0].n), 0);
  await pool.end();
});

test('company member lists only own molds', async () => {
  const { app, pool } = await setup();
  const agent = request.agent(app);
  await login(agent, 'alpha@example.test');
  const response = await agent.get('/api/molds');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map((m) => m.name), ['Alpha mold']);
  await pool.end();
});

test('other-company mold id cannot be read, updated, or used for QR', async () => {
  const { app, pool, ids } = await setup();
  const agent = request.agent(app);
  const csrf = await login(agent, 'alpha@example.test');
  assert.equal((await agent.get(`/api/molds/${ids.m2}`)).status, 404);
  assert.equal((await agent.get(`/api/molds/${ids.m2}/qr`)).status, 404);
  assert.equal((await agent.post(`/api/molds/${ids.m2}/shots`).set('X-CSRF-Token',csrf).set('X-Idempotency-Key','other-company-0001').send({ recordedOn: '2026-08-13', counterValue: 250, notes: '' })).status, 404);
  const total = await pool.query('SELECT SUM(shot_count)::text AS total FROM shot_records WHERE mold_id=$1', [ids.m2]);
  assert.equal(total.rows[0].total, '200');
  await pool.end();
});

test('company member can create and update only own data with actor attribution', async () => {
  const { app, pool, ids } = await setup();
  const agent = request.agent(app);
  const csrf = await login(agent, 'alpha@example.test');
  const created = await agent.post('/api/molds').set('X-CSRF-Token',csrf).send({ name: 'Alpha new mold' });
  assert.equal(created.status, 201);
  const shot = await agent.post(`/api/molds/${ids.m1}/shots`).set('X-CSRF-Token',csrf).set('X-Idempotency-Key','own-company-000001').send({ recordedOn: '2026-08-13', counterValue: 125, notes: 'test' });
  assert.equal(shot.status, 201);
  const saved = await pool.query('SELECT company_id,created_by_user_id FROM shot_records WHERE id=$1', [shot.body.id]);
  assert.equal(Number(saved.rows[0].company_id), Number(ids.c1));
  assert.equal(Number(saved.rows[0].created_by_user_id), Number(ids.u1));
  await pool.end();
});

test('server calculates the increment from the submitted cumulative counter', async () => {
  const { app, pool, ids } = await setup();
  const agent = request.agent(app);
  const csrf = await login(agent, 'alpha@example.test');
  const response = await agent.post(`/api/molds/${ids.m1}/shots`).set('X-CSRF-Token',csrf).set('X-Idempotency-Key','counter-value-0001').send({ recordedOn: '2026-08-13', counterValue: 158, notes: '' });
  assert.equal(response.status, 201);
  assert.equal(response.body.shot_count, '58');
  assert.equal(response.body.counter_value, '158');
  await pool.end();
});

test('repeating the same request id does not add shots twice', async () => {
  const { app, pool, ids } = await setup();
  const agent = request.agent(app);
  const csrf = await login(agent, 'alpha@example.test');
  const post = () => agent.post(`/api/molds/${ids.m1}/shots`).set('X-CSRF-Token',csrf).set('X-Idempotency-Key','retry-safe-000001').send({ recordedOn: '2026-08-13', counterValue: 150, notes: 'retry' });
  assert.equal((await post()).status, 201);
  const repeated = await post();
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.duplicate, true);
  const total = await pool.query('SELECT SUM(shot_count)::text AS total FROM shot_records WHERE mold_id=$1', [ids.m1]);
  assert.equal(total.rows[0].total, '150');
  await pool.end();
});

test('counter values that do not advance the current total are rejected', async () => {
  const { app, pool, ids } = await setup();
  const agent = request.agent(app);
  const csrf = await login(agent, 'alpha@example.test');
  const response = await agent.post(`/api/molds/${ids.m1}/shots`).set('X-CSRF-Token',csrf).set('X-Idempotency-Key','stale-counter-0001').send({ recordedOn: '2026-08-13', counterValue: 100, notes: '' });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'COUNTER_NOT_ADVANCED');
  await pool.end();
});

test('CSRF token is required and invalid token returns 403', async () => {
  const { app, pool } = await setup();
  const agent = request.agent(app);
  await login(agent, 'alpha@example.test');
  assert.equal((await agent.post('/api/molds').send({ name: 'blocked' })).status, 403);
  assert.equal((await agent.post('/api/molds').set('X-CSRF-Token','invalid').send({ name: 'blocked' })).status, 403);
  await pool.end();
});

test('login failures are rate limited with Japanese message', async () => {
  const { pool } = await setup();
  const app = createApp({ pool, secureCookies:false, loginMaxAttempts:2 });
  const agent = request.agent(app);
  assert.equal((await agent.post('/api/auth/login').send({email:'alpha@example.test',password:'wrong'})).status,401);
  assert.equal((await agent.post('/api/auth/login').send({email:'alpha@example.test',password:'wrong'})).status,401);
  const limited = await agent.post('/api/auth/login').send({email:'alpha@example.test',password:'test-password'});
  assert.equal(limited.status,429);
  assert.match(limited.body.error,/多すぎます/);
  await pool.end();
});

test('expired session is rejected and removed on next successful login', async () => {
  const { app, pool, ids } = await setup();
  await pool.query("INSERT INTO auth_sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,'expired','expired','2000-01-01')",[ids.u1]);
  const agent=request.agent(app);
  await login(agent,'alpha@example.test');
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM auth_sessions WHERE token_hash='expired'")).rows[0].n),0);
  await pool.end();
});

test('an expired session cookie is rejected', async () => {
  const { app, pool, ids } = await setup();
  const { tokenHash } = require('../server');
  await pool.query(
    "INSERT INTO auth_sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,'expired','2000-01-01')",
    [ids.u1, tokenHash('expired-cookie')]
  );
  const response = await request(app).get('/api/auth/session').set('Cookie', 'shot_session=expired-cookie');
  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'AUTH_REQUIRED');
  await pool.end();
});

test('QR login return path accepts only internal application paths', () => {
  assert.equal(safeReturnPath('/molds/123'), '/molds/123');
  assert.equal(safeReturnPath('/scan'), '/scan');
  assert.equal(safeReturnPath('https://evil.example/molds/1'), '/');
  assert.equal(safeReturnPath('//evil.example'), '/');
  assert.equal(safeReturnPath('/molds/1?next=https://evil.example'), '/');
});

test('logout requires CSRF and invalidates the session', async () => {
  const { app, pool }=await setup();
  const agent=request.agent(app);
  const csrf=await login(agent,'alpha@example.test');
  assert.equal((await agent.post('/api/auth/logout')).status,403);
  assert.equal((await agent.post('/api/auth/logout').set('X-CSRF-Token',csrf)).status,204);
  assert.equal((await agent.get('/api/auth/session')).status,401);
  await pool.end();
});

test('reloading an authenticated page refreshes the CSRF token', async () => {
  const { app, pool, ids }=await setup();
  const agent=request.agent(app);
  const oldCsrf=await login(agent,'alpha@example.test');
  const session=await agent.get('/api/auth/session');
  assert.equal(session.status,200);
  assert.ok(session.body.csrfToken);
  assert.notEqual(session.body.csrfToken,oldCsrf);
  assert.equal((await agent.post(`/api/molds/${ids.m1}/maintenances`).set('X-CSRF-Token',oldCsrf).send({performedOn:'2026-08-19',details:'old token'})).status,403);
  assert.equal((await agent.post(`/api/molds/${ids.m1}/maintenances`).set('X-CSRF-Token',session.body.csrfToken).send({performedOn:'2026-08-19',details:'refreshed token'})).status,201);
  await pool.end();
});
