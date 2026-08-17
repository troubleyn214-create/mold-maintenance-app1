import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const [backupPath,resultPath,dataDir]=process.argv.slice(2);
if(!backupPath||!resultPath||!dataDir) throw new Error('paths required');
const backup=JSON.parse(fs.readFileSync(backupPath,'utf8'));
const port=55432;
const password='staging-process-only';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bin=path.join(root,'node_modules','@embedded-postgres','windows-x64','native','bin');
const executable=(name)=>path.join(bin,`${name}.exe`);
const env={...process.env,PATH:`${bin};${process.env.PATH||''}`};
let serverProcess;
function run(name,args){
 return new Promise((resolve,reject)=>{
  const child=spawn(executable(name),args,{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='';
  child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(new Error(`${name} failed (${code}): ${output}`)));
 });
}
async function initialiseAndStart(){
 fs.mkdirSync(dataDir,{recursive:true});
 if(!fs.existsSync(path.join(dataDir,'PG_VERSION'))){
  const passwordFile=`${dataDir}.password`;
  fs.writeFileSync(passwordFile,password,{encoding:'utf8',mode:0o600});
  try{await run('initdb',['-D',dataDir,'-U','postgres',`--pwfile=${passwordFile}`,'--auth=scram-sha-256','--encoding=UTF8','--no-locale']);}
  finally{fs.rmSync(passwordFile,{force:true});}
 }
 const log=fs.openSync(path.join(dataDir,'postgres.log'),'a');
 serverProcess=spawn(executable('postgres'),['-D',dataDir,'-p',String(port),'-h','127.0.0.1'],{env,stdio:['ignore',log,log],windowsHide:true});
 for(let attempt=0;attempt<50;attempt+=1){
  const probe=connection('postgres');
  try{await probe.query('SELECT 1');await probe.end();return;}catch{await probe.end().catch(()=>{});await new Promise(r=>setTimeout(r,100));}
 }
 throw new Error('isolated PostgreSQL did not become ready');
}
async function stop(){if(serverProcess){serverProcess.kill('SIGTERM');await new Promise(r=>setTimeout(r,500));}}
const connection=(database)=>new pg.Pool({host:'127.0.0.1',port,user:'postgres',password,database});
const schema=`
CREATE TABLE molds(id BIGINT PRIMARY KEY,name TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE maintenance_logs(id BIGINT PRIMARY KEY,mold_id BIGINT NOT NULL REFERENCES molds(id) ON DELETE CASCADE,performed_on DATE NOT NULL,details TEXT NOT NULL,shot_count BIGINT NOT NULL CHECK(shot_count>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE shot_molds(id BIGINT PRIMARY KEY,name TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE shot_records(id BIGINT PRIMARY KEY,mold_id BIGINT NOT NULL REFERENCES shot_molds(id) ON DELETE CASCADE,recorded_on DATE NOT NULL,shot_count BIGINT NOT NULL CHECK(shot_count>0),notes TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX shot_records_mold_id_idx ON shot_records(mold_id,recorded_on DESC,id DESC);`;

async function metrics(pool){
 const tables=(await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map(r=>r.table_name);
 const counts={},ranges={};
 for(const t of tables){counts[t]=Number((await pool.query(`SELECT COUNT(*)::text n FROM "${t}"`)).rows[0].n);const has=(await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'",[t])).rowCount;if(has)ranges[t]=(await pool.query(`SELECT MIN(id)::text min,MAX(id)::text max FROM "${t}"`)).rows[0];}
 const totals=tables.includes('shot_molds')?(await pool.query("SELECT m.id::text id,COALESCE(SUM(r.shot_count),0)::text total FROM shot_molds m LEFT JOIN shot_records r ON r.mold_id=m.id GROUP BY m.id ORDER BY m.id")).rows:[];
 const orphan=tables.includes('shot_records')?Number((await pool.query('SELECT COUNT(*)::text n FROM shot_records r LEFT JOIN shot_molds m ON m.id=r.mold_id WHERE m.id IS NULL')).rows[0].n):0;
 const invalid=tables.includes('shot_records')?(await pool.query('SELECT COUNT(*) FILTER(WHERE mold_id IS NULL)::text null_mold,COUNT(*) FILTER(WHERE recorded_on IS NULL)::text null_date,COUNT(*) FILTER(WHERE shot_count IS NULL)::text null_shots,COUNT(*) FILTER(WHERE shot_count<=0)::text bad_shots FROM shot_records')).rows[0]:{};
 return {tables,counts,ranges,totals,orphan,invalid};
}
async function seed(pool){
 await pool.query(schema);
 for(const r of backup.data.molds||[])await pool.query('INSERT INTO molds VALUES($1,$2,$3)',[r.id,r.name,r.created_at]);
 for(const r of backup.data.maintenance_logs||[])await pool.query('INSERT INTO maintenance_logs VALUES($1,$2,$3,$4,$5,$6)',[r.id,r.mold_id,r.performed_on,r.details,r.shot_count,r.created_at]);
 for(const r of backup.data.shot_molds||[])await pool.query('INSERT INTO shot_molds VALUES($1,$2,$3)',[r.id,r.name,r.created_at]);
 for(const r of backup.data.shot_records||[])await pool.query('INSERT INTO shot_records VALUES($1,$2,$3,$4,$5,$6)',[r.id,r.mold_id,r.recorded_on,r.shot_count,r.notes,r.created_at]);
}
function protectedData(metrics){
 const names=['maintenance_logs','molds','shot_molds','shot_records'];
 return {
  counts:Object.fromEntries(names.map(name=>[name,metrics.counts[name]])),
  ranges:Object.fromEntries(names.map(name=>[name,metrics.ranges[name]])),
  totals:metrics.totals,orphan:metrics.orphan,invalid:metrics.invalid
 };
}
function migration(name){return fs.readFileSync(path.join(root,'migrations',name),'utf8').replace(/^BEGIN;|^COMMIT;/gm,'');}

let result={postgresVersion:null,restore:null,migration:null,rollback:null,constraints:null,legacyUnaffected:null};
try{
 await initialiseAndStart();
 const admin=connection('postgres');await admin.query('CREATE DATABASE staging_restore');await admin.end();
 const db=connection('staging_restore');
 result.postgresVersion=(await db.query('SHOW server_version')).rows[0].server_version;
 await seed(db);const before=await metrics(db);result.restore=before;
 const legacyBefore={molds:before.counts.molds,logs:before.counts.maintenance_logs,ranges:{molds:before.ranges.molds,logs:before.ranges.maintenance_logs}};
 const client=await db.connect();
 try{
  await client.query('BEGIN');await client.query(migration('001_p0_nullable.sql'));
  const hash=await bcrypt.hash('staging-only',4);
  const company=(await client.query("INSERT INTO companies(name) VALUES('STAGING ONLY') RETURNING id")).rows[0].id;
  const user=(await client.query("INSERT INTO users(email,password_hash) VALUES('staging@example.invalid',$1) RETURNING id",[hash])).rows[0].id;
  await client.query("INSERT INTO memberships VALUES($1,$2,'admin',CURRENT_TIMESTAMP)",[company,user]);
  await client.query('UPDATE shot_molds SET company_id=$1',[company]);await client.query('UPDATE shot_records SET company_id=$1,created_by_user_id=$2',[company,user]);
  const afterBackfill=await metrics(client);await client.query(migration('002_p0_constraints.sql'));const afterConstraints=await metrics(client);
  const constraints=(await client.query("SELECT conname,contype FROM pg_constraint WHERE conrelid IN('shot_molds'::regclass,'shot_records'::regclass) ORDER BY conname")).rows;
  const indexes=(await client.query("SELECT tablename,indexname FROM pg_indexes WHERE schemaname='public' AND tablename IN('shot_molds','shot_records','auth_sessions') ORDER BY tablename,indexname")).rows;
  result.migration={before,afterBackfill,afterConstraints,dataMatch:JSON.stringify(protectedData(before))===JSON.stringify(protectedData(afterConstraints))};result.constraints={constraints,indexes};
  await client.query('ROLLBACK');
 }finally{client.release();}
 const rolledBack=await metrics(db);result.rollback={metrics:rolledBack,dataMatch:JSON.stringify(before)===JSON.stringify(rolledBack),newTablesRemaining:(await db.query("SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name IN('companies','users','memberships','auth_sessions')")).rows[0].n};
 result.legacyUnaffected={before:legacyBefore,after:{molds:rolledBack.counts.molds,logs:rolledBack.counts.maintenance_logs,ranges:{molds:rolledBack.ranges.molds,logs:rolledBack.ranges.maintenance_logs}},match:legacyBefore.molds===rolledBack.counts.molds&&legacyBefore.logs===rolledBack.counts.maintenance_logs&&JSON.stringify(legacyBefore.ranges)===JSON.stringify({molds:rolledBack.ranges.molds,logs:rolledBack.ranges.maintenance_logs})};
 await db.end();fs.writeFileSync(resultPath,JSON.stringify(result,null,2));console.log(JSON.stringify({postgresVersion:result.postgresVersion,restore:result.restore,migrationMatch:result.migration.dataMatch,rollback:result.rollback,legacyUnaffected:result.legacyUnaffected.match,constraintCount:result.constraints.constraints.length,indexCount:result.constraints.indexes.length},null,2));
}finally{await stop();}
