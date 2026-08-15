import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import pg from 'pg';

const [root,resultPath,dumpPath,dataDir,dbPasswordFile,testPasswordFile]=process.argv.slice(2);
if(![root,resultPath,dumpPath,dataDir,dbPasswordFile,testPasswordFile].every(Boolean)) throw new Error('paths required');
const bin=path.join(root,'postgresql-18.4-client','pgsql','bin');
const exe=name=>path.join(bin,`${name}.exe`);
const dbPassword=fs.readFileSync(dbPasswordFile,'utf8').trim();
const testPassword=fs.readFileSync(testPasswordFile,'utf8').trim();
const env={...process.env,PATH:`${bin};${process.env.PATH||''}`,PGPASSWORD:dbPassword};
function run(name,args){const r=spawnSync(exe(name),args,{env,encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error(`${name} failed (${r.status}): ${r.stderr}`);}
const log=fs.openSync(path.join(dataDir,'postgres.log'),'a');
const postgres=spawn(exe('postgres'),['-D',dataDir,'-p','55433','-h','127.0.0.1'],{env,stdio:['ignore',log,log],windowsHide:true});
async function ready(){for(let i=0;i<80;i+=1){const p=new pg.Pool({host:'127.0.0.1',port:55433,user:'postgres',password:dbPassword,database:'postgres'});try{await p.query('SELECT 1');await p.end();return;}catch{await p.end().catch(()=>{});await new Promise(r=>setTimeout(r,100));}}throw new Error('PostgreSQL not ready');}
await ready();
if(!fs.existsSync(resultPath)){
 run('createdb',['-h','127.0.0.1','-p','55433','-U','postgres','restore_original']);
 run('pg_restore',['--exit-on-error','--no-owner','--no-acl','-h','127.0.0.1','-p','55433','-U','postgres','-d','restore_original',dumpPath]);
 run('createdb',['-h','127.0.0.1','-p','55433','-U','postgres','staging_e2e']);
 run('pg_restore',['--exit-on-error','--no-owner','--no-acl','-h','127.0.0.1','-p','55433','-U','postgres','-d','staging_e2e',dumpPath]);
 const verify=spawnSync(process.execPath,[path.join(import.meta.dirname,'final-postgres-verify.mjs'),resultPath],{cwd:path.resolve(import.meta.dirname,'..'),env:{...env,STAGING_DB_PASSWORD:dbPassword,STAGING_TEST_PASSWORD:testPassword},encoding:'utf8',windowsHide:true});
 if(verify.status!==0)throw new Error(`verification failed: ${verify.stderr}`);
 console.log(verify.stdout.trim());
}
const dbUrl=`postgresql://postgres:${encodeURIComponent(dbPassword)}@127.0.0.1:55433/staging_e2e`;
const appLog=fs.openSync(path.join(root,'backups','staging-app.log'),'a');
const app=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...env,DATABASE_URL:dbUrl,DATABASE_SSL:'false',PORT:'3100'},stdio:['ignore',appLog,appLog],windowsHide:true});
for(let i=0;i<80;i+=1){try{const r=await fetch('http://127.0.0.1:3100/api/health');if(r.ok)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===79)throw new Error('staging app not ready');}
console.log(JSON.stringify({restore:true,verification:true,stagingUrl:'http://127.0.0.1:3100'}));
const shutdown=()=>{app.kill('SIGTERM');postgres.kill('SIGTERM');};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
await new Promise(()=>{});
