const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { newDb, DataType } = require('pg-mem');

const migration = (name) => fs.readFileSync(path.join(__dirname, '..', 'migrations', name), 'utf8');

async function snapshot(pool) {
  const counts = (await pool.query(`SELECT
    (SELECT COUNT(*) FROM shot_molds)::text AS molds,
    (SELECT COUNT(*) FROM shot_records)::text AS records`)).rows[0];
  const ranges = (await pool.query(`SELECT
    (SELECT MIN(id) FROM shot_molds)::text AS mold_min,
    (SELECT MAX(id) FROM shot_molds)::text AS mold_max,
    (SELECT MIN(id) FROM shot_records)::text AS record_min,
    (SELECT MAX(id) FROM shot_records)::text AS record_max`)).rows[0];
  const totals = (await pool.query(`SELECT m.id::text AS id,COALESCE(SUM(r.shot_count),0)::text AS total
    FROM shot_molds m LEFT JOIN shot_records r ON r.mold_id=m.id GROUP BY m.id ORDER BY m.id`)).rows;
  return { counts, ranges, totals };
}

test('staging migration preserves ids and totals before enforcing tenant constraints', async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'char_length', args: [DataType.text], returns: DataType.integer, implementation: (value) => value.length });
  db.public.none(`
    CREATE TABLE shot_molds (id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE shot_records (id BIGSERIAL PRIMARY KEY,mold_id BIGINT NOT NULL REFERENCES shot_molds(id) ON DELETE CASCADE,recorded_on DATE NOT NULL,shot_count BIGINT NOT NULL CHECK(shot_count>0),notes TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO shot_molds(id,name) VALUES(10,'staging-A'),(20,'staging-B');
    INSERT INTO shot_records(id,mold_id,recorded_on,shot_count) VALUES(100,10,'2026-08-01',40),(200,10,'2026-08-02',60),(300,20,'2026-08-03',25);
  `);
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  const before = await snapshot(pool);

  await pool.query(migration('001_p0_nullable.sql'));
  const passwordHash = await bcrypt.hash('staging-only-password', 4);
  const companyId = (await pool.query("INSERT INTO companies(name) VALUES('STAGING ONLY') RETURNING id")).rows[0].id;
  const userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES('staging-admin@example.invalid',$1) RETURNING id", [passwordHash])).rows[0].id;
  await pool.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'admin')", [companyId, userId]);
  await pool.query('UPDATE shot_molds SET company_id=$1 WHERE company_id IS NULL', [companyId]);
  await pool.query('UPDATE shot_records SET company_id=$1,created_by_user_id=$2 WHERE company_id IS NULL OR created_by_user_id IS NULL', [companyId, userId]);

  const afterBackfill = await snapshot(pool);
  assert.deepEqual(afterBackfill, before);
  assert.equal(String((await pool.query('SELECT COUNT(*)::text AS n FROM shot_molds WHERE company_id IS NULL')).rows[0].n), '0');
  assert.equal(String((await pool.query('SELECT COUNT(*)::text AS n FROM shot_records WHERE company_id IS NULL OR created_by_user_id IS NULL')).rows[0].n), '0');

  await pool.query(migration('002_p0_constraints.sql'));
  await pool.query(migration('003_counter_idempotency.sql'));
  const afterConstraints = await snapshot(pool);
  assert.deepEqual(afterConstraints, before);
  await assert.rejects(pool.query("INSERT INTO shot_molds(name,company_id) VALUES('invalid',NULL)"));
  await assert.rejects(pool.query("INSERT INTO shot_records(mold_id,company_id,created_by_user_id,recorded_on,shot_count) VALUES(10,999,$1,'2026-08-13',1)", [userId]));
  await assert.rejects(pool.query("INSERT INTO shot_records(mold_id,company_id,created_by_user_id,recorded_on,shot_count,counter_value,idempotency_key) VALUES(10,$1,$2,'2026-08-13',1,126,'staging-request-0001'),(10,$1,$2,'2026-08-13',1,127,'staging-request-0001')", [companyId, userId]));
  await pool.end();
});
