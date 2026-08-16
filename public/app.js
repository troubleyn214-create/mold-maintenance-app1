const app = document.querySelector('#app');
const logoutButton = document.querySelector('#logout');
let csrfToken = sessionStorage.getItem('csrfToken') || '';
const escapeHtml = (v) => String(v).replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]);
const today = () => new Date().toLocaleDateString('sv-SE');
const formatDate = (v) => String(v).slice(0, 10);
const formatShots = (v) => new Intl.NumberFormat('ja-JP').format(Number(v));
const { safeReturnPath } = ShotPathUtils;

async function request(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {...(options.headers || {})};
  if (!['GET','HEAD','OPTIONS'].includes(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(url, {...options, headers});
  const data = response.status === 204 ? null : await response.json();
  if (response.status === 401 && !url.startsWith('/api/auth/')) {
    location.href = `/login?returnTo=${encodeURIComponent(safeReturnPath(location.pathname))}`;
    throw Object.assign(new Error('ログインが必要です。'), {status: 401});
  }
  if (!response.ok) throw Object.assign(new Error(data?.error || '処理に失敗しました。'), {status:response.status,code:data?.code});
  return data;
}
function setMessage(message, error=false) { const el=document.querySelector('#message'); if(el) el.innerHTML=`<div class="notice${error?' error':''}">${escapeHtml(message)}</div>`; }
function authenticated() { logoutButton.hidden=false; }

function renderLogin() {
  logoutButton.hidden=true;
  const returnTo=safeReturnPath(new URLSearchParams(location.search).get('returnTo'));
  app.innerHTML=`<section class="login-shell"><div class="login-card"><p class="eyebrow">金型ショット数管理</p><h1>ログイン</h1><p class="muted">登録済みのログインIDまたはメールアドレスとパスワードを入力してください。</p><form id="login-form"><label for="login-id">ログインID／メールアドレス</label><input id="login-id" type="text" inputmode="text" autocomplete="username" autocapitalize="none" spellcheck="false" required><label for="password">パスワード</label><input id="password" type="password" autocomplete="current-password" required><button class="primary-wide" type="submit">ログイン</button></form><div id="message" aria-live="assertive"></div></div></section>`;
  document.querySelector('#login-form').addEventListener('submit',async(e)=>{e.preventDefault();const b=e.currentTarget.querySelector('button');b.disabled=true;try{const result=await request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({loginId:document.querySelector('#login-id').value,password:document.querySelector('#password').value})});csrfToken=result.csrfToken;sessionStorage.setItem('csrfToken',csrfToken);location.replace(returnTo);}catch(error){b.disabled=false;setMessage(error.message,true);}});
}

async function renderHome() {
  authenticated();
  app.innerHTML=`<div class="page-title"><div><p class="eyebrow">生産終了時に記録</p><h1>金型ショット数</h1></div><a class="button" href="/scan">QRを読み取る</a></div><section class="card"><h2>金型を登録</h2><form id="mold-form" class="row"><div><label for="mold-name">金型名</label><input id="mold-name" required maxlength="100" placeholder="例：フロントカバー A-01"></div><div class="button-column"><button>登録する</button></div></form><div id="message"></div></section><section class="card"><h2>登録済み金型</h2><div id="mold-list">読み込み中...</div></section>`;
  document.querySelector('#mold-form').addEventListener('submit',async(e)=>{e.preventDefault();try{const mold=await request('/api/molds',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.querySelector('#mold-name').value})});location.href=`/molds/${mold.id}`;}catch(error){setMessage(error.message,true);}});
  const molds=await request('/api/molds');
  document.querySelector('#mold-list').innerHTML=molds.length?`<ul class="mold-list">${molds.map(m=>`<li><a href="/molds/${m.id}"><span><strong>${escapeHtml(m.name)}</strong><small>最終記録：${m.last_recorded_on?escapeHtml(m.last_recorded_on):'未記録'}</small></span><span class="list-total">${formatShots(m.total_shots)}<small>累計ショット</small></span></a></li>`).join('')}</ul>`:'まだ金型は登録されていません。';
}

async function renderMold(id) {
  authenticated(); app.innerHTML='<p>読み込み中...</p>';
  const mold=await request(`/api/molds/${id}`);
  app.innerHTML=`<a href="/" class="back">‹ 金型一覧へ</a><section class="mold-identity"><span>入力対象の金型</span><h1>${escapeHtml(mold.name)}</h1><small>管理No. ${id}</small></section><section class="total-card"><span>累計ショット数</span><strong>${formatShots(mold.total_shots)}</strong><small>shots</small></section><div id="message"></div><section class="card accent"><h2>生産終了後のカウンター値を記録</h2><form id="shot-form"><label for="counter-value">金型カウンターの累計値</label><input id="counter-value" class="shot-input" type="number" inputmode="numeric" min="${Number(mold.total_shots)+1}" required autofocus><p class="muted">現在値 ${formatShots(mold.total_shots)} より大きい値を入力</p><button class="primary-wide">累計値を記録</button><div class="compact-options"><details><summary>日付を変更</summary><input id="recorded-on" type="date" value="${today()}" required></details><details><summary>＋ メモを追加</summary><input id="notes" maxlength="500"></details></div></form></section><section class="card"><div class="actions"><button id="show-qr" class="secondary">QRコードを表示</button><a class="button secondary" href="/scan">別のQRを読む</a></div><div id="qr-area"></div></section><section class="card"><h2>入力履歴</h2>${recordsHtml(mold.records)}</section>`;
  document.querySelector('#show-qr').onclick=async()=>{const qr=await request(`/api/molds/${id}/qr`);document.querySelector('#qr-area').innerHTML=`<div class="qr-wrap"><img src="${qr.dataUrl}" alt="QRコード"><p>${escapeHtml(qr.url)}</p></div>`;};
  document.querySelector('#shot-form').onsubmit=async(e)=>{e.preventDefault();const b=e.currentTarget.querySelector('button');b.disabled=true;const requestKey=`shot-request-${id}`;let requestId=sessionStorage.getItem(requestKey);if(!requestId){requestId=globalThis.crypto?.randomUUID?crypto.randomUUID():`${Date.now()}_${Math.random().toString(36).slice(2)}`;sessionStorage.setItem(requestKey,requestId);}try{const counterValue=Number(document.querySelector('#counter-value').value);await request(`/api/molds/${id}/shots`,{method:'POST',headers:{'Content-Type':'application/json','X-Idempotency-Key':requestId},body:JSON.stringify({recordedOn:document.querySelector('#recorded-on').value,counterValue,notes:document.querySelector('#notes').value})});sessionStorage.removeItem(requestKey);await renderMold(id);setMessage('金型カウンターの累計値を記録しました。');}catch(error){b.disabled=false;setMessage(error.message,true);}};
}
function recordsHtml(records){return records.length?`<ul class="history">${records.map(r=>`<li><div><time>${escapeHtml(formatDate(r.recorded_on))}</time>${r.notes?`<p>${escapeHtml(r.notes)}</p>`:''}</div><strong>${formatShots(r.shot_count)}<small> ショット</small></strong></li>`).join('')}</ul>`:'<p class="muted">まだ記録はありません。</p>';}
function renderScan(){authenticated();app.innerHTML=`<a href="/" class="back">‹ 金型一覧へ</a><h1>金型QRを読み取る</h1><section class="card"><p>QRコードを枠内に写してください。</p><div id="reader" class="scanner"></div><div id="message"></div></section>`;const scanner=new Html5QrcodeScanner('reader',{fps:10,qrbox:{width:230,height:230}},false);scanner.render(text=>{try{const url=new URL(text);if(url.origin!==location.origin)throw new Error();const match=url.pathname.match(/^\/molds\/(\d+)$/);if(!match)throw new Error();scanner.clear();location.href=url.pathname;}catch{setMessage('このアプリの金型QRコードではありません。',true);}},()=>{});}
logoutButton.onclick=async()=>{try{await request('/api/auth/logout',{method:'POST'});}finally{csrfToken='';sessionStorage.removeItem('csrfToken');location.replace('/login');}};
async function start(){if(location.pathname==='/login')return renderLogin();try{await request('/api/auth/session');}catch(error){if(error.status===401){location.href=`/login?returnTo=${encodeURIComponent(safeReturnPath(location.pathname))}`;return;}throw error;}const match=location.pathname.match(/^\/molds\/(\d+)$/);if(match)return renderMold(match[1]);if(location.pathname==='/scan')return renderScan();return renderHome();}
start().catch(error=>{app.innerHTML=`<div class="notice error">${escapeHtml(error.message)}</div>`;});
