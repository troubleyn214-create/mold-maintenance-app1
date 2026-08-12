const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { newDb } = require('pg-mem');
const { createApp } = require('../server');

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
  const passwordHash = await bcrypt.hash('test-password', 4);
  const c1 = (await pool.query("INSERT INTO companies(name) VALUES('Alpha') RETURNING id")).rows[0].id;
  const c2 = (await pool.query("INSERT INTO companies(name) VALUES('Beta') RETURNING id")).rows[0].id;
  const u1 = (await pool.query("INSERT INTO users(email,password_hash) VALUES('alpha@example.test',$1) RETURNING id", [passwordHash])).rows[0].id;
  const u2 = (await pool.query("INSERT INTO users(email,password_hash) VALUES('beta@example.test',$1) RETURNING id", [passwordHash])).rows[0].id;
  await pool.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'admin'),($3,$4,'admin')", [c1, u1, c2, u2]);
  const m1 = (await pool.query("INSERT INTO shot_molds(company_id,name) VALUES($1,'Alpha mold') RETURNING id", [c1])).rows[0].id;
  const m2 = (await pool.query("INSERT INTO shot_molds(company_id,name) VALUES($1,'Beta mold') RETURNING id", [c2])).rows[0].id;
  await pool.query("INSERT INTO shot_records(company_id,mold_id,created_by_user_id,recorded_on,shot_count) VALUES($1,$2,$3,'2026-08-01',100),($4,$5,$6,'2026-08-02',200)", [c1, m1, u1, c2, m2, u2]);
  return { pool, app: createApp({ pool, secureCookies: false }), ids: { c1, c2, u1, u2, m1, m2 } };
}

async function login(agent, email) {
  const response = await agent.post('/api/auth/login').send({ email, password: 'test-password' });
  assert.equal(response.status, 200);
}

test('unauthenticated mold reads and writes return 401', async () => {
  const { app, pool } = await setup();
  assert.equal((await request(app).get('/api/molds')).status, 401);
  assert.equal((await request(app).post('/api/molds').send({ name: 'blocked' })).status, 401);
  assert.equal((await request(app).post('/api/molds/1/shots').send({ recordedOn: '2026-08-13', shotCount: 1 })).status, 401);
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
  await login(agent, 'alpha@example.test');
  assert.equal((await agent.get(`/api/molds/${ids.m2}`)).status, 404);
  assert.equal((await agent.get(`/api/molds/${ids.m2}/qr`)).status, 404);
  assert.equal((await agent.post(`/api/molds/${ids.m2}/shots`).send({ recordedOn: '2026-08-13', shotCount: 50, notes: '' })).status, 404);
  const total = await pool.query('SELECT SUM(shot_count)::text AS total FROM shot_records WHERE mold_id=$1', [ids.m2]);
  assert.equal(total.rows[0].total, '200');
  await pool.end();
});

test('company member can create and update only own data with actor attribution', async () => {
  const { app, pool, ids } = await setup();
  const agent = request.agent(app);
  await login(agent, 'alpha@example.test');
  const created = await agent.post('/api/molds').send({ name: 'Alpha new mold' });
  assert.equal(created.status, 201);
  const shot = await agent.post(`/api/molds/${ids.m1}/shots`).send({ recordedOn: '2026-08-13', shotCount: 25, notes: 'test' });
  assert.equal(shot.status, 201);
  const saved = await pool.query('SELECT company_id,created_by_user_id FROM shot_records WHERE id=$1', [shot.body.id]);
  assert.equal(Number(saved.rows[0].company_id), Number(ids.c1));
  assert.equal(Number(saved.rows[0].created_by_user_id), Number(ids.u1));
  await pool.end();
});
