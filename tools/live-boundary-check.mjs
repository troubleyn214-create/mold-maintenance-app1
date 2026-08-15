import fs from 'node:fs';
import pg from 'pg';

const [resultPath,passwordFile,dbPasswordFile]=process.argv.slice(2);
const password=fs.readFileSync(passwordFile,'utf8').trim();
const dbPassword=fs.readFileSync(dbPasswordFile,'utf8').trim();
const base='http://127.0.0.1:3100';
async function login(email){
 const response=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
 const body=await response.json();
 return {status:response.status,cookie:response.headers.get('set-cookie').split(';')[0],csrf:body.csrfToken};
}
async function call(path,{cookie,csrf},options={}){const headers={...(options.headers||{}),cookie};if(csrf)headers['x-csrf-token']=csrf;const response=await fetch(`${base}${path}`,{...options,headers});return {status:response.status,body:response.status===204?null:await response.json()};}
const a=await login('qa-a@example.invalid');
const b=await login('qa-b@example.invalid');
const bOwn=await call('/api/molds/2',b);
const before=Number(bOwn.body.total_shots);
const results={
 logins:{a:a.status,b:b.status},
 aReadsB:await call('/api/molds/2',a),
 aReadsBQr:await call('/api/molds/2/qr',a),
 aPostsB:await call('/api/molds/2/shots',a,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({recordedOn:'2026-08-13',shotCount:999,notes:'must not persist'})})
};
const after=Number((await call('/api/molds/2',b)).body.total_shots);
results.companyBTotal={before,after,unchanged:before===after};
const pool=new pg.Pool({host:'127.0.0.1',port:55433,user:'postgres',password:dbPassword,database:'staging_e2e'});
await pool.query("UPDATE auth_sessions SET expires_at='2000-01-01' WHERE user_id=(SELECT id FROM users WHERE email='qa-a@example.invalid')");
results.expiredSession=await call('/api/auth/session',a);
await pool.end();
fs.writeFileSync(resultPath,JSON.stringify(results,null,2));
console.log(JSON.stringify({logins:results.logins,aReadsB:results.aReadsB.status,aReadsBQr:results.aReadsBQr.status,aPostsB:results.aPostsB.status,companyBTotal:results.companyBTotal,expiredSession:results.expiredSession.status},null,2));
