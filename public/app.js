const app = document.querySelector('#app');

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[c]);
const today = () => new Date().toISOString().slice(0, 10);

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '処理に失敗しました。');
  return data;
}

function setMessage(message, error = false) {
  const target = document.querySelector('#message');
  if (target) target.innerHTML = `<div class="notice${error ? ' error' : ''}">${escapeHtml(message)}</div>`;
}

async function renderHome() {
  app.innerHTML = `<h1>金型一覧</h1>
    <section class="card"><h2>金型を登録</h2><form id="mold-form" class="row">
      <div><label for="mold-name">金型名称</label><input id="mold-name" required maxlength="100" placeholder="例：フロントカバー金型 A-01" /></div>
      <div style="flex:0 0 auto;min-width:auto"><button type="submit">登録する</button></div>
    </form><div id="message"></div></section>
    <section class="card"><div class="actions no-print"><a class="button" href="/scan">QRコードを読み取る</a></div><h2>登録済み金型</h2><div id="mold-list" class="muted">読み込み中...</div></section>`;
  document.querySelector('#mold-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.querySelector('#mold-name').value;
    try {
      const mold = await request('/api/molds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      location.href = `/molds/${mold.id}`;
    } catch (error) { setMessage(error.message, true); }
  });
  try {
    const molds = await request('/api/molds');
    document.querySelector('#mold-list').innerHTML = molds.length ? `<ul class="mold-list">${molds.map((m) => `<li><a href="/molds/${m.id}"><span>${escapeHtml(m.name)}</span><span aria-hidden="true">›</span></a></li>`).join('')}</ul>` : 'まだ金型は登録されていません。';
  } catch (error) { document.querySelector('#mold-list').textContent = error.message; }
}

async function renderMold(id) {
  app.innerHTML = '<p class="muted">読み込み中...</p>';
  try {
    const mold = await request(`/api/molds/${id}`);
    app.innerHTML = `<a href="/" class="back">‹ 金型一覧へ</a><h1>${escapeHtml(mold.name)}</h1>
      <div id="message"></div><section class="card no-print"><div class="actions"><button id="show-qr">QRコードを表示・印刷</button><a class="button secondary" href="/scan">QRコードを読み取る</a></div><div id="qr-area"></div></section>
      <section class="card"><h2>メンテナンス履歴</h2><div id="history">${historyHtml(mold.logs)}</div></section>
      <section class="card"><h2>履歴を追加</h2><form id="log-form"><div class="row"><div><label for="performed-on">実施日</label><input id="performed-on" type="date" value="${today()}" required /></div><div><label for="shot-count">ショット数</label><input id="shot-count" type="number" min="0" step="1" required placeholder="例: 12000" /></div></div><p><label for="details">内容</label><textarea id="details" maxlength="1000" required placeholder="実施したメンテナンス内容を入力"></textarea></p><button type="submit">履歴を追加する</button></form></section>`;
    document.querySelector('#show-qr').addEventListener('click', () => showQr(mold));
    document.querySelector('#log-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await request(`/api/molds/${id}/logs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ performedOn: document.querySelector('#performed-on').value, details: document.querySelector('#details').value, shotCount: document.querySelector('#shot-count').value }) });
        await renderMold(id);
      } catch (error) { setMessage(error.message, true); }
    });
  } catch (error) { app.innerHTML = `<a href="/" class="back">‹ 金型一覧へ</a><div class="notice error">${escapeHtml(error.message)}</div>`; }
}

function historyHtml(logs) {
  if (!logs.length) return '<p class="muted">メンテナンス履歴はまだありません。</p>';
  return `<ul class="history">${logs.map((log) => `<li><time datetime="${escapeHtml(log.performed_on)}">${escapeHtml(log.performed_on)}</time><div>${escapeHtml(log.details).replace(/\n/g, '<br>')}</div><div class="meta">ショット数：${escapeHtml(log.shot_count)}</div></li>`).join('')}</ul>`;
}

async function showQr(mold) {
  const area = document.querySelector('#qr-area');
  area.innerHTML = '<p class="muted">QRコードを生成中...</p>';
  try {
    const qr = await request(`/api/molds/${mold.id}/qr`);
    area.innerHTML = `<div class="qr-wrap"><h2>${escapeHtml(mold.name)}</h2><img src="${qr.dataUrl}" alt="${escapeHtml(mold.name)} のQRコード"><p class="qr-url">${escapeHtml(qr.url)}</p><button class="no-print" onclick="window.print()">このQRコードを印刷</button></div>`;
  } catch (error) { area.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`; }
}

function renderScan() {
  app.innerHTML = `<a href="/" class="back">‹ 金型一覧へ</a><h1>QRコードを読み取る</h1><section class="card"><p class="muted">カメラへのアクセスを許可して、金型のQRコードを枠内に写してください。</p><div id="reader" class="scanner"></div><div id="message"></div></section>`;
  const start = () => {
    if (!window.Html5QrcodeScanner) return setMessage('読み取り機能を読み込めませんでした。ネットワーク接続を確認してください。', true);
    const scanner = new Html5QrcodeScanner('reader', { fps: 10, qrbox: { width: 230, height: 230 } }, false);
    scanner.render((decodedText) => {
      try {
        const url = new URL(decodedText);
        const match = url.pathname.match(/^\/molds\/(\d+)$/);
        if (match) { scanner.clear(); location.href = url.pathname; return; }
      } catch { /* continue */ }
      setMessage('このアプリの金型QRコードではありません。', true);
    }, () => {});
  };
  window.Html5QrcodeScanner ? start() : window.addEventListener('load', start, { once: true });
}

const match = location.pathname.match(/^\/molds\/(\d+)$/);
if (match) renderMold(match[1]); else if (location.pathname === '/scan') renderScan(); else renderHome();
