import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const [resultPath] = process.argv.slice(2);
const password = process.env.STAGING_DB_PASSWORD;
const testPassword = process.env.STAGING_TEST_PASSWORD;
if (!resultPath || !password || !testPassword) throw new Error('required staging-only settings are missing');
const root = path.resolve(import.meta.dirname, '..');
const connection = database => new pg.Pool({host:'127.0.0.1',port:55433,user:'postgres',password,database});
const migration = name => fs.readFileSync(path.join(root,'migrations',name),'utf8').replace(/^BEGIN;|^COMMIT;/gm,'');
const protectedTables=['maintenance_logs','molds','shot_molds','shot_records'];

async function metrics(db) {
  const tables=(await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")).rows.map(r=>r.table_name);
  const counts={},ranges={};
  for(const table of tables){
    counts[table]=Number((await db.query(`SELECT COUNT(*)::text n FROM "${table}"`)).rows[0].n);
    if((await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'",[table])).rowCount){
      ranges[table]=(await db.query(`SELECT MIN(id)::text min,MAX(id)::text max FROM "${table}"`)).rows[0];
    }
  }
  const totals=(await db.query('SELECT m.id::text,COALESCE(SUM(r.shot_count),0)::text total FROM shot_molds m LEFT JOIN shot_records r ON r.mold_id=m.id GROUP BY m.id ORDER BY m.id')).rows;
  const orphan=Number((await db.query('SELECT COUNT(*)::text n FROM shot_records r LEFT JOIN shot_molds m ON m.id=r.mold_id WHERE m.id IS NULL')).rows[0].n);
  const invalid=(await db.query('SELECT COUNT(*) FILTER(WHERE mold_id IS NULL)::text null_mold,COUNT(*) FILTER(WHERE recorded_on IS NULL)::text null_date,COUNT(*) FILTER(WHERE shot_count IS NULL)::text null_shots,COUNT(*) FILTER(WHERE shot_count<=0)::text bad_shots FROM shot_records')).rows[0];
  const constraints=(await db.query("SELECT c.conrelid::regclass::text table_name,c.conname,c.contype FROM pg_constraint c WHERE c.connamespace='public'::regnamespace ORDER BY 1,2")).rows;
  const indexes=(await db.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2")).rows;
  const sequences=(await db.query("SELECT sequencename,last_value::text,start_value::text,increment_by::text FROM pg_sequences WHERE schemaname='public' ORDER BY 1")).rows;
  return {tables,counts,ranges,totals,orphan,invalid,constraints,indexes,sequences};
}
function protectedData(m){return {tables:m.tables.filter(t=>protectedTables.includes(t)),counts:Object.fromEntries(protectedTables.map(t=>[t,m.counts[t]])),ranges:Object.fromEntries(protectedTables.map(t=>[t,m.ranges[t]])),totals:m.totals,orphan:m.orphan,invalid:m.invalid};}

const result={};
const original=connection('restore_original');
result.restored=await metrics(original);
const sequenceClient=await original.connect();
try{
  await sequenceClient.query('BEGIN');
  const beforeMold=Number(result.restored.ranges.shot_molds.max);
  const insertedMold=Number((await sequenceClient.query("INSERT INTO shot_molds(name) VALUES('SEQUENCE CHECK - ROLLED BACK') RETURNING id")).rows[0].id);
  const beforeRecord=Number(result.restored.ranges.shot_records.max);
  const insertedRecord=Number((await sequenceClient.query("INSERT INTO shot_records(mold_id,recorded_on,shot_count,notes) VALUES($1,CURRENT_DATE,1,'SEQUENCE CHECK') RETURNING id",[insertedMold])).rows[0].id);
  result.sequenceInsert={shotMold:{beforeMax:beforeMold,newId:insertedMold,noCollision:insertedMold>beforeMold},shotRecord:{beforeMax:beforeRecord,newId:insertedRecord,noCollision:insertedRecord>beforeRecord}};
  await sequenceClient.query('ROLLBACK');
} finally { sequenceClient.release(); }

const rollbackClient=await original.connect();
try{
  const before=await metrics(rollbackClient);
  await rollbackClient.query('BEGIN');
  await rollbackClient.query(migration('001_p0_nullable.sql'));
  const hash=await bcrypt.hash(testPassword,4);
  const company=(await rollbackClient.query("INSERT INTO companies(name,plan_code,status) VALUES('Staging Rollback Co','beta','active') RETURNING id")).rows[0].id;
  const user=(await rollbackClient.query("INSERT INTO users(email,password_hash) VALUES('rollback@example.invalid',$1) RETURNING id",[hash])).rows[0].id;
  await rollbackClient.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'admin')",[company,user]);
  await rollbackClient.query('UPDATE shot_molds SET company_id=$1',[company]);
  await rollbackClient.query('UPDATE shot_records SET company_id=$1,created_by_user_id=$2',[company,user]);
  await rollbackClient.query(migration('002_p0_constraints.sql'));
  const after=await metrics(rollbackClient);
  result.migration={dataMatch:JSON.stringify(protectedData(before))===JSON.stringify(protectedData(after)),after};
  await rollbackClient.query('ROLLBACK');
  const rolledBack=await metrics(rollbackClient);
  result.rollback={dataMatch:JSON.stringify(protectedData(before))===JSON.stringify(protectedData(rolledBack)),newTablesRemaining:rolledBack.tables.filter(t=>['companies','users','memberships','auth_sessions'].includes(t)).length};
} finally { rollbackClient.release(); await original.end(); }

const e2e=connection('staging_e2e');
await e2e.query(migration('001_p0_nullable.sql'));
const hash=await bcrypt.hash(testPassword,8);
const companyA=(await e2e.query("INSERT INTO companies(name,plan_code,status) VALUES('Staging Factory A','beta','active') RETURNING id")).rows[0].id;
const companyB=(await e2e.query("INSERT INTO companies(name,plan_code,status) VALUES('Staging Factory B','beta','active') RETURNING id")).rows[0].id;
const userA=(await e2e.query("INSERT INTO users(email,password_hash) VALUES('qa-a@example.invalid',$1) RETURNING id",[hash])).rows[0].id;
const userB=(await e2e.query("INSERT INTO users(email,password_hash) VALUES('qa-b@example.invalid',$1) RETURNING id",[hash])).rows[0].id;
await e2e.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'admin'),($3,$4,'admin')",[companyA,userA,companyB,userB]);
await e2e.query('UPDATE shot_molds SET company_id=$1',[companyA]);
await e2e.query('UPDATE shot_records SET company_id=$1,created_by_user_id=$2',[companyA,userA]);
const moldB=(await e2e.query("INSERT INTO shot_molds(company_id,name) VALUES($1,'Staging B Mold') RETURNING id",[companyB])).rows[0].id;
await e2e.query("INSERT INTO shot_records(company_id,mold_id,created_by_user_id,recorded_on,shot_count,notes) VALUES($1,$2,$3,CURRENT_DATE,200,'staging only')",[companyB,moldB,userB]);
await e2e.query(migration('002_p0_constraints.sql'));
result.e2e={companyA,userA,emailA:'qa-a@example.invalid',companyB,userB,emailB:'qa-b@example.invalid',moldA:Number(result.restored.ranges.shot_molds.min),moldB,metrics:await metrics(e2e)};
await e2e.end();
fs.writeFileSync(resultPath,JSON.stringify(result,null,2));
console.log(JSON.stringify({restore:protectedData(result.restored),sequenceInsert:result.sequenceInsert,migrationDataMatch:result.migration.dataMatch,rollback:result.rollback,e2e:{moldA:result.e2e.moldA,moldB:result.e2e.moldB}},null,2));
