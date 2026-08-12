const app = document.querySelector('#app');

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[c]);
const today = () => new Date().toLocaleDateString('sv-SE');
const formatShots = (value) => new Intl.NumberFormat('ja-JP').format(Number(value));

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

function formatDisplayDate(value) {
  const [year, month, day] = value.split('-');
  return `${year}/${month}/${day}${value === today() ? '（今日）' : ''}`;
}

async function renderHome() {
  app.innerHTML = `<div class="page-title"><div><p class="eyebrow">生産終了時に記録</p><h1>金型ショット数</h1></div><a class="button" href="/scan">QRを読み取る</a></div>
    <section class="card"><h2>金型を登録</h2><form id="mold-form" class="row">
      <div><label for="mold-name">金型名</label><input id="mold-name" required maxlength="100" placeholder="例：フロントカバー A-01" /></div>
      <div class="button-column"><button type="submit">登録する</button></div>
    </form><div id="message"></div></section>
    <section class="card"><h2>登録済み金型</h2><div id="mold-list" class="muted">読み込み中...</div></section>`;

  document.querySelector('#mold-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const mold = await request('/api/molds', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: document.querySelector('#mold-name').value })
      });
      location.href = `/molds/${mold.id}`;
    } catch (error) { setMessage(error.message, true); }
  });

  try {
    const molds = await request('/api/molds');
    document.querySelector('#mold-list').innerHTML = molds.length
      ? `<ul class="mold-list">${molds.map((m) => `<li><a href="/molds/${m.id}"><span><strong>${escapeHtml(m.name)}</strong><small>最終記録：${m.last_recorded_on ? escapeHtml(m.last_recorded_on) : '未記録'}</small></span><span class="list-total">${formatShots(m.total_shots)}<small>累計ショット</small></span></a></li>`).join('')}</ul>`
      : 'まだ金型は登録されていません。';
  } catch (error) { document.querySelector('#mold-list').textContent = error.message; }
}

async function renderMold(id) {
  app.innerHTML = '<p class="muted">読み込み中...</p>';
  try {
    const mold = await request(`/api/molds/${id}`);
    app.innerHTML = `<a href="/" class="back">‹ 金型一覧へ</a>
      <section class="mold-identity"><span>入力対象の金型</span><h1>${escapeHtml(mold.name)}</h1><small>管理No. ${escapeHtml(mold.id)}</small></section>
      <section class="total-card"><span>累計ショット数</span><strong>${formatShots(mold.total_shots)}</strong><small>shots</small></section>
      <div id="message"></div>
      <section class="card accent"><h2>今回の生産数を記録</h2><form id="shot-form">
        <label for="shot-count">今回ショット数</label><input id="shot-count" class="shot-input" type="number" inputmode="numeric" min="1" step="1" required placeholder="例：1200" autofocus />
        <div id="shot-preview" class="shot-preview" aria-live="polite">数字を入力すると加算後の累計を確認できます</div>
        <button id="submit-shots" class="primary-wide" type="submit">ショット数を記録</button>
        <div class="compact-options">
          <details><summary>日付：<span id="date-label">${formatDisplayDate(today())}</span>　変更</summary><label class="detail-label" for="recorded-on">生産日</label><input id="recorded-on" type="date" value="${today()}" required /></details>
          <details><summary>＋ メモを追加</summary><label class="detail-label" for="notes">メモ（任意）</label><input id="notes" maxlength="500" placeholder="例：製品A、昼勤" /></details>
        </div>
      </form></section>
      <section class="card no-print"><div class="actions"><button id="show-qr" class="secondary">QRコードを表示・印刷</button><a class="button secondary" href="/scan">別のQRを読み取る</a></div><div id="qr-area"></div></section>
      <section class="card"><h2>入力履歴</h2><div>${recordsHtml(mold.records)}</div></section>`;

    const shotInput = document.querySelector('#shot-count');
    const preview = document.querySelector('#shot-preview');
    const submitButton = document.querySelector('#submit-shots');
    const totalBefore = Number(mold.total_shots);
    const updatePreview = () => {
      const added = Number(shotInput.value);
      if (!Number.isSafeInteger(added) || added <= 0) {
        preview.textContent = '数字を入力すると加算後の累計を確認できます';
        submitButton.textContent = 'ショット数を記録';
        return;
      }
      preview.innerHTML = `<strong>${formatShots(totalBefore)} + ${formatShots(added)} → ${formatShots(totalBefore + added)} shots</strong>`;
      submitButton.textContent = `${formatShots(added)} shotsを記録`;
    };
    shotInput.addEventListener('input', updatePreview);
    document.querySelector('#recorded-on').addEventListener('change', (event) => {
      document.querySelector('#date-label').textContent = formatDisplayDate(event.target.value);
    });
    document.querySelector('#show-qr').addEventListener('click', () => showQr(mold));
    document.querySelector('#shot-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const addedShots = Number(shotInput.value);
        const updatedTotal = totalBefore + addedShots;
        await request(`/api/molds/${id}/shots`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recordedOn: document.querySelector('#recorded-on').value,
            shotCount: document.querySelector('#shot-count').value,
            notes: document.querySelector('#notes').value
          })
        });
        await renderMold(id);
        const message = document.querySelector('#message');
        message.innerHTML = `<div class="notice success-notice"><strong>✓ ${formatShots(addedShots)} shotsを記録しました</strong><span>累計 ${formatShots(updatedTotal)} shots</span><a class="button next-scan" href="/scan">次のQRを読む</a></div>`;
        message.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (error) {
        button.disabled = false;
        setMessage(error.message, true);
      }
    });
  } catch (error) {
    app.innerHTML = `<a href="/" class="back">‹ 金型一覧へ</a><div class="notice error">${escapeHtml(error.message)}</div>`;
  }
}

function recordsHtml(records) {
  if (!records.length) return '<p class="muted">ショット数はまだ記録されていません。</p>';
  return `<ul class="history">${records.map((record) => `<li><div><time datetime="${escapeHtml(record.recorded_on)}">${escapeHtml(record.recorded_on)}</time>${record.notes ? `<p>${escapeHtml(record.notes)}</p>` : ''}</div><strong>+${formatShots(record.shot_count)}</strong></li>`).join('')}</ul>`;
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
  app.innerHTML = `<a href="/" class="back">‹ 金型一覧へ</a><h1>金型QRを読み取る</h1><section class="card"><p class="muted">QRコードを枠内に写すと、ショット数入力画面へ移動します。</p><div id="reader" class="scanner"></div><div id="message"></div></section>`;
  const start = () => {
    if (!window.Html5QrcodeScanner) return setMessage('読み取り機能を読み込めませんでした。', true);
    const scanner = new Html5QrcodeScanner('reader', { fps: 10, qrbox: { width: 230, height: 230 } }, false);
    scanner.render((decodedText) => {
      try {
        const url = new URL(decodedText);
        const match = url.pathname.match(/^\/molds\/(\d+)$/);
        if (match) { scanner.clear(); location.href = url.pathname; return; }
      } catch { /* invalid QR */ }
      setMessage('このアプリの金型QRコードではありません。', true);
    }, () => {});
  };
  window.Html5QrcodeScanner ? start() : window.addEventListener('load', start, { once: true });
}

const match = location.pathname.match(/^\/molds\/(\d+)$/);
if (match) renderMold(match[1]); else if (location.pathname === '/scan') renderScan(); else renderHome();
