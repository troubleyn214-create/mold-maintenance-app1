const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { newDb } = require('pg-mem');

const secretPath = process.argv[2];
const backupPath = process.argv[3];
const resultPath = process.argv[4];
if (!secretPath || !backupPath || !resultPath) throw new Error('paths are required');

const productionUrl = fs.readFileSync(secretPath, 'utf8').trim();
const parsed = new URL(productionUrl);
const source = new Pool({ connectionString: productionUrl, ssl: { rejectUnauthorized: false }, max: 1 });

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function metrics(client) {
  const tables = (await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
    ORDER BY table_name
  `)).rows.map((row) => row.table_name);
  const result = { tables, counts: {}, idRanges: {}, moldTotals: [], orphanRecords: null, invalidValues: {} };
  for (const table of tables) {
    result.counts[table] = Number((await client.query(`SELECT COUNT(*)::text AS n FROM ${quoteIdentifier(table)}`)).rows[0].n);
    const hasId = (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'`, [table])).rowCount > 0;
    if (hasId) {
      const range = (await client.query(`SELECT MIN(id)::text AS min, MAX(id)::text AS max FROM ${quoteIdentifier(table)}`)).rows[0];
      result.idRanges[table] = { min: range.min == null ? null : String(range.min), max: range.max == null ? null : String(range.max) };
    }
  }
  if (tables.includes('shot_molds') && tables.includes('shot_records')) {
    result.moldTotals = (await client.query(`
      SELECT m.id::text AS mold_id, COALESCE(SUM(r.shot_count),0)::text AS total_shots
      FROM shot_molds m LEFT JOIN shot_records r ON r.mold_id=m.id
      GROUP BY m.id ORDER BY m.id
    `)).rows.map((row) => ({ mold_id: String(row.mold_id), total_shots: String(row.total_shots) }));
    result.orphanRecords = Number((await client.query(`
      SELECT COUNT(*)::text AS n FROM shot_records r
      LEFT JOIN shot_molds m ON m.id=r.mold_id WHERE m.id IS NULL
    `)).rows[0].n);
    const invalid = (await client.query(`
      SELECT
        COALESCE(SUM(CASE WHEN mold_id IS NULL THEN 1 ELSE 0 END),0)::text AS null_mold_id,
        COALESCE(SUM(CASE WHEN recorded_on IS NULL THEN 1 ELSE 0 END),0)::text AS null_recorded_on,
        COALESCE(SUM(CASE WHEN shot_count IS NULL THEN 1 ELSE 0 END),0)::text AS null_shot_count,
        COALESCE(SUM(CASE WHEN shot_count <= 0 THEN 1 ELSE 0 END),0)::text AS nonpositive_shot_count
      FROM shot_records
    `)).rows[0];
    result.invalidValues = Object.fromEntries(Object.entries(invalid).map(([key, value]) => [key, String(value)]));
  }
  return result;
}

async function main() {
  const client = await source.connect();
  let backup;
  let sourceMetrics;
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const readOnly = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    sourceMetrics = await metrics(client);
    const columns = (await client.query(`
      SELECT table_name,column_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='public'
      ORDER BY table_name,ordinal_position
    `)).rows;
    const data = {};
    for (const table of sourceMetrics.tables) {
      data[table] = (await client.query(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY 1`)).rows;
    }
    backup = {
      format: 'shot-count-logical-backup-v1',
      createdAt: new Date().toISOString(),
      source: { hostIdentifier: parsed.hostname.split('.')[0], database: parsed.pathname.slice(1), transactionReadOnly: readOnly },
      columns,
      data
    };
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), { mode: 0o600 });
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await source.end();
  }

  const restored = newDb({ autoCreateForeignKeyIndices: true });
  restored.public.none(`
    CREATE TABLE molds (
      id BIGINT PRIMARY KEY, name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE maintenance_logs (
      id BIGINT PRIMARY KEY,
      mold_id BIGINT NOT NULL REFERENCES molds(id) ON DELETE CASCADE,
      performed_on DATE NOT NULL,
      details TEXT NOT NULL,
      shot_count BIGINT NOT NULL CHECK (shot_count >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE shot_molds (
      id BIGINT PRIMARY KEY, name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE shot_records (
      id BIGINT PRIMARY KEY,
      mold_id BIGINT NOT NULL REFERENCES shot_molds(id) ON DELETE CASCADE,
      recorded_on DATE NOT NULL,
      shot_count BIGINT NOT NULL CHECK (shot_count > 0),
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const adapter = restored.adapters.createPg();
  const target = new adapter.Pool();
  for (const mold of backup.data.molds || []) {
    await target.query('INSERT INTO molds(id,name,created_at) VALUES($1,$2,$3)', [mold.id, mold.name, mold.created_at]);
  }
  for (const log of backup.data.maintenance_logs || []) {
    await target.query('INSERT INTO maintenance_logs(id,mold_id,performed_on,details,shot_count,created_at) VALUES($1,$2,$3,$4,$5,$6)', [log.id, log.mold_id, log.performed_on, log.details, log.shot_count, log.created_at]);
  }
  for (const mold of backup.data.shot_molds || []) {
    await target.query('INSERT INTO shot_molds(id,name,created_at) VALUES($1,$2,$3)', [mold.id, mold.name, mold.created_at]);
  }
  for (const record of backup.data.shot_records || []) {
    await target.query('INSERT INTO shot_records(id,mold_id,recorded_on,shot_count,notes,created_at) VALUES($1,$2,$3,$4,$5,$6)', [record.id, record.mold_id, record.recorded_on, record.shot_count, record.notes, record.created_at]);
  }
  const restoredMetrics = await metrics(target);
  await target.end();
  const comparison = {
    tablesMatch: JSON.stringify(sourceMetrics.tables) === JSON.stringify(restoredMetrics.tables),
    countsMatch: JSON.stringify(sourceMetrics.counts) === JSON.stringify(restoredMetrics.counts),
    idRangesMatch: JSON.stringify(sourceMetrics.idRanges) === JSON.stringify(restoredMetrics.idRanges),
    moldTotalsMatch: JSON.stringify(sourceMetrics.moldTotals) === JSON.stringify(restoredMetrics.moldTotals),
    orphanRecordsMatch: sourceMetrics.orphanRecords === restoredMetrics.orphanRecords,
    invalidValuesMatch: JSON.stringify(sourceMetrics.invalidValues) === JSON.stringify(restoredMetrics.invalidValues)
  };
  const result = {
    source: backup.source,
    backupPath,
    backupBytes: fs.statSync(backupPath).size,
    sourceMetrics,
    restoredMetrics,
    comparison,
    allMatched: Object.values(comparison).every(Boolean)
  };
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    source: backup.source,
    backupBytes: result.backupBytes,
    tables: sourceMetrics.tables,
    counts: sourceMetrics.counts,
    idRanges: sourceMetrics.idRanges,
    moldTotals: sourceMetrics.moldTotals,
    orphanRecords: sourceMetrics.orphanRecords,
    invalidValues: sourceMetrics.invalidValues,
    comparison,
    allMatched: result.allMatched
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
