'use strict';
const VERSION = '2.1.0';

/* ================= 小工具 ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // 本地日期（避免 UTC 差 8 小時）
const todayStr = () => ymd(new Date());
const thisMonth = () => todayStr().slice(0, 7);
const money = n => new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 }).format(n);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const buzz = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }
};
const EPOCH = '1970-01-01T00:00:00.000Z';
const nowISO = () => new Date().toISOString();
const TYPE_LABEL = { expense: '支出', income: '收入', transfer: '轉帳' };
const COLORS = ['#16a37a', '#f59e0b', '#3b82f6', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#94a3b8'];
const WEEK = '日一二三四五六';
const monthOf = d => d.slice(0, 7);
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number), d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const monthLabel = m => `${m.slice(0, 4)} 年 ${Number(m.slice(5))} 月`;
const sum = (rows, type) => rows.reduce((s, x) => s + (x.type === type ? x.amount : 0), 0);
const CURRENCIES = ['TWD', 'USD', 'JPY', 'EUR', 'KRW', 'CNY', 'HKD', 'GBP', 'AUD', 'SGD', 'THB', 'VND', 'MYR', 'CAD'];
const MINUS = '−', OPS = `+${MINUS}×÷`;
const fmtNum = n => Number(n).toLocaleString('zh-TW', { maximumFractionDigits: 2 });

/* ================= IndexedDB（舊資料完全相容） ================= */
const STORES = ['entries', 'accounts', 'categories', 'budgets', 'recurring', 'meta'];
const dbReady = new Promise((ok, bad) => {
  const r = indexedDB.open('ledger-db', 4);
  r.onupgradeneeded = () => { STORES.forEach(n => { if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, { keyPath: 'id' }); }); };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => bad(r.error);
});
const run = (name, mode, fn) => dbReady.then(d => new Promise((ok, bad) => {
  const t = d.transaction(name, mode); const req = fn(t.objectStore(name));
  t.oncomplete = () => ok(req && req.result); t.onerror = () => bad(t.error); t.onabort = () => bad(t.error);
}));
const all = n => run(n, 'readonly', o => o.getAll());
const getOne = (n, id) => run(n, 'readonly', o => o.get(id));
const put = (n, item) => run(n, 'readwrite', o => o.put(item));
const putMany = (n, items) => items.length ? run(n, 'readwrite', o => { items.forEach(i => o.put(i)); }) : Promise.resolve();
// 刪除一律留下「墓碑」（deleted:true），這樣刪除也能同步到其他裝置
const kill = (n, item) => put(n, { ...item, deleted: true, updatedAt: nowISO() });
const live = x => !x.deleted;

/* ================= 狀態 ================= */
const S = {
  rawEntries: [], entries: [], accounts: [], cats: [], budgets: {}, recurring: [], remind: { id: 'reminder', enabled: false, time: '21:00', lastNotified: '' },
  dirty: 0, tab: 'home', month: thisMonth(), filter: 'all', q: '', statType: 'expense'
};
const defaults = {
  accounts: [['cash', '現金'], ['bank', '銀行帳戶']],
  categories: [['food', '🍜', '餐飲'], ['transport', '🚌', '交通'], ['shopping', '🛍️', '購物'], ['home', '🏠', '居家'], ['education', '📚', '教育'], ['salary', '💰', '薪資'], ['investment', '📈', '投資']]
};
async function seed() {
  if (!(await all('accounts')).length) await putMany('accounts', defaults.accounts.map(([id, name]) => ({ id, name })));
  if (!(await all('categories')).length) await putMany('categories', defaults.categories.map(([id, icon, name]) => ({ id, icon, name })));
}
// IndexedDB 依 ID 排序；預設項目照預設順序，自訂項目依 order（拖曳排序／建立時間）排後面
const ordOf = (x, defs) => x.order ?? (defs.findIndex(d => d[0] === x.id) + 1 || 1e6);
const sortBy = (list, defs) => list.sort((a, b) => ordOf(a, defs) - ordOf(b, defs));

async function load() {
  const [e, a, c, b, r, rem] = await Promise.all([...['entries', 'accounts', 'categories', 'budgets', 'recurring'].map(all), getOne('meta', 'reminder')]);
  S.rawEntries = e;
  S.entries = e.filter(live).sort((x, y) => y.date.localeCompare(x.date) || (y.updatedAt || '').localeCompare(x.updatedAt || ''));
  S.accounts = sortBy(a.filter(live), defaults.accounts);
  S.cats = sortBy(c.filter(live), defaults.categories);
  S.budgets = Object.fromEntries(b.filter(x => live(x) && x.amount > 0).map(x => [x.id, x.amount]));
  S.recurring = r.filter(live);
  if (rem) S.remind = rem;
  const last = store.get('lastSync') || '';
  S.dirty = [e, a, c, b, r].reduce((n, list) => n + list.filter(x => (x.updatedAt || '') > last && (x.updatedAt || '') > EPOCH).length, 0);
  render();
}
let autoTimer;
const touched = () => { clearTimeout(autoTimer); autoTimer = setTimeout(() => doSync(true), 4000); };
const commit = async () => { await load(); touched(); };

const accName = id => (S.accounts.find(a => a.id === id) || {}).name || id;
const catOf = id => S.cats.find(c => c.id === id) || { icon: '🏷️', name: id };
const accBalance = id => S.entries.reduce((s, x) => {
  if (x.type === 'income' && x.account === id) return s + x.amount;
  if (x.type === 'expense' && x.account === id) return s - x.amount;
  if (x.type === 'transfer') return s + (x.toAccount === id ? x.amount : 0) - (x.account === id ? x.amount : 0);
  return s;
}, 0);

/* ================= 對話框（底部抽屜）共用 ================= */
function openDlg(d) {
  d.classList.remove('closing'); d.style.transform = '';
  if (!d.open) { d.showModal(); history.pushState({ sheet: d.id }, ''); }
}
function closeDlg(d, fromPop) {
  if (!d.open || d.classList.contains('closing')) return;
  d.classList.add('closing');
  setTimeout(() => {
    d.close(); d.classList.remove('closing'); d.style.transform = '';
    if (!fromPop && history.state && history.state.sheet) history.back();
  }, 210);
}
$$('dialog.sheet').forEach(d => {
  d.addEventListener('cancel', e => { e.preventDefault(); closeDlg(d); });
  d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close-dlg]')) closeDlg(d); });
  const grab = $('.grabber', d); let drag = null;
  grab.addEventListener('pointerdown', e => { drag = { y: e.clientY, dy: 0 }; grab.setPointerCapture(e.pointerId); d.style.transition = 'none'; });
  grab.addEventListener('pointermove', e => { if (!drag) return; drag.dy = Math.max(0, e.clientY - drag.y); d.style.transform = `translateY(${drag.dy}px)`; });
  const end = () => { if (!drag) return; const far = drag.dy > 110; drag = null; d.style.transition = ''; if (far) closeDlg(d); else d.style.transform = ''; };
  grab.addEventListener('pointerup', end); grab.addEventListener('pointercancel', end);
});
window.addEventListener('popstate', () => $$('dialog.sheet[open]').forEach(d => closeDlg(d, true)));

/* 通用表單面板：用來編輯分類、帳戶、預算、固定帳目 */
const formDlg = $('#form-dlg');
function openForm({ title, note, fields = [], saveLabel = '儲存', onSave, onDelete, deleteLabel = '刪除' }) {
  const f = $('#fd-form'); $('#fd-title').textContent = title;
  const input = x => x.type === 'select'
    ? `<label>${esc(x.label)}<select name="${x.k}">${x.options.map(([v, l]) => `<option value="${esc(v)}"${v === x.value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`
    : `<label>${esc(x.label)}<input name="${x.k}" type="${x.type || 'text'}" value="${esc(x.value ?? '')}" placeholder="${esc(x.placeholder || '')}" ${x.attrs || ''} autocomplete="off"></label>`;
  f.innerHTML = (note ? `<p class="hint">${note}</p>` : '') + fields.map(input).join('') +
    `<div class="form-actions">${onDelete ? `<button type="button" class="danger" id="fd-del">${deleteLabel}</button>` : ''}<button class="primary">${saveLabel}</button></div>`;
  f.onsubmit = async e => { e.preventDefault(); if ((await onSave(Object.fromEntries(new FormData(f)))) !== false) closeDlg(formDlg); };
  if (onDelete) $('#fd-del').onclick = async () => { if ((await onDelete()) !== false) closeDlg(formDlg); };
  openDlg(formDlg);
}

/* ================= 提示 ================= */
let toastTimer;
function toast(msg, act) {
  const t = $('#toast'), b = $('#toast-act');
  $('#toast-msg').textContent = msg;
  b.hidden = !act; b.textContent = act ? act.label : ''; b.onclick = () => { t.hidden = true; clearTimeout(toastTimer); act && act.fn(); };
  t.hidden = false; t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer); if (!(act && act.sticky)) toastTimer = setTimeout(() => { t.hidden = true; }, act ? 5000 : 2800);
}

/* ================= 預算 ================= */
const spendOf = (m, cat, exclId) => S.entries.reduce((s, x) => s + (x.type === 'expense' && monthOf(x.date) === m && (!cat || x.category === cat) && x.id !== exclId ? x.amount : 0), 0);
const meterClass = r => r >= 1 ? 'over' : r >= .8 ? 'warn' : '';
function budgetAlert(en, old) {
  const m = thisMonth(); if (en.type !== 'expense' || monthOf(en.date) !== m) return null;
  const msgs = [];
  [[en.category, S.budgets[en.category], `${catOf(en.category).name}預算`], ['total', S.budgets.total, '本月總預算']].forEach(([k, b, label]) => {
    if (!b) return; const cat = k === 'total' ? null : k, excl = spendOf(m, cat, en.id);
    const oldAmt = old && old.type === 'expense' && monthOf(old.date) === m && (!cat || old.category === cat) ? old.amount : 0;
    const before = excl + oldAmt, after = excl + en.amount;
    if (after >= b) msgs.push({ lvl: 2, msg: `⚠️ ${label}已超支 ${money(after - b)}` });
    else if (before < b * .8 && after >= b * .8) msgs.push({ lvl: 1, msg: `${label}已用 ${Math.round(after / b * 100)}%` });
  });
  msgs.sort((a, b) => b.lvl - a.lvl); return msgs[0] && msgs[0].msg;
}
function renderBudget() {
  const m = thisMonth(), total = S.budgets.total, cats = Object.keys(S.budgets).filter(k => k !== 'total' && S.cats.some(c => c.id === k));
  const box = $('#budget-card');
  if (!total && !cats.length) { box.innerHTML = `<button class="card budget-empty" data-tab="settings"><span style="font-size:1.5rem">🎯</span><div><b>設定月預算</b><br>掌握每月花費，快超支時會提醒你</div></button>`; return; }
  let html = '<div class="card budget">';
  if (total) {
    const spent = spendOf(m), r = spent / total, [y, mo] = m.split('-').map(Number), dim = new Date(y, mo, 0).getDate(), left = dim - new Date().getDate() + 1;
    html += `<div class="budget-head"><div><small>本月預算</small><br><b>${money(spent)}</b> <small>/ ${money(total)}</small></div><small>${Math.round(r * 100)}%</small></div>
      <div class="meter ${meterClass(r)}"><i style="width:${Math.min(100, r * 100)}%"></i></div>
      <p class="budget-note ${r >= 1 ? 'over' : ''}">${r >= 1 ? `已超支 ${money(spent - total)}` : `還剩 ${money(total - spent)}，平均每天可花 ${money((total - spent) / left)}（剩 ${left} 天）`}</p>`;
  }
  const minis = cats.map(id => ({ id, b: S.budgets[id], s: spendOf(m, id) })).sort((a, b) => b.s / b.b - a.s / a.b).slice(0, 4);
  if (minis.length) html += `<div class="${total ? 'mini-meters' : 'stack'}">${minis.map(x => `<div><span>${esc(catOf(x.id).icon)} ${esc(catOf(x.id).name)}</span><span class="meter ${meterClass(x.s / x.b)}"><i style="width:${Math.min(100, x.s / x.b * 100)}%"></i></span><em>${money(x.s)} / ${money(x.b)}</em></div>`).join('')}</div>`;
  box.innerHTML = html + '</div>';
}

/* ================= 渲染 ================= */
function entryRow(x) {
  const isT = x.type === 'transfer', c = catOf(x.category);
  const title = isT ? `轉帳　${esc(accName(x.account))} → ${esc(accName(x.toAccount))}` : esc(c.name);
  const sub = [x.date.slice(5).replace('-', '/'), isT ? '' : accName(x.account), x.currency ? `${x.currency} ${fmtNum(x.foreignAmount)}` : '', x.note].filter(Boolean).map(esc).join(' · ');
  const sign = x.type === 'income' ? '+' : x.type === 'expense' ? '-' : '';
  return `<div class="swipe"><button class="swipe-del" data-del="${esc(x.id)}" aria-label="刪除">刪除</button>
    <div class="entry" data-edit="${esc(x.id)}" role="button" tabindex="0"><span class="ico">${isT ? '↔' : esc(c.icon)}</span>
    <div class="meta"><p>${title}</p><small>${sub}</small></div><span class="amount ${x.type}">${sign}${money(x.amount)}</span></div></div>`;
}
const emptyBox = (icon, msg) => `<div class="empty"><b>${icon}</b>${msg}</div>`;

function renderHome() {
  const cur = S.entries.filter(x => monthOf(x.date) === thisMonth()), inc = sum(cur, 'income'), out = sum(cur, 'expense');
  $('#home-date').textContent = new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  $('#balance').textContent = money(inc - out); $('#income').textContent = money(inc); $('#expense').textContent = money(out);
  $('#account-cards').innerHTML = S.accounts.map(a => `<article class="account-card"><p>${esc(a.name)}</p><b>${money(accBalance(a.id))}</b></article>`).join('');
  $('#recent').innerHTML = S.entries.length ? S.entries.slice(0, 6).map(entryRow).join('') : emptyBox('🌱', '還沒有帳目<br>點下方 ＋ 記下第一筆吧');
  const hhmm = `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
  $('#remind').hidden = !(S.remind.enabled && hhmm >= S.remind.time && !S.entries.some(x => x.date === todayStr()));
  renderBudget();
}

function renderList() {
  const month = S.entries.filter(x => monthOf(x.date) === S.month);
  $('#l-income').textContent = money(sum(month, 'income')); $('#l-expense').textContent = money(sum(month, 'expense'));
  const q = S.q.trim().toLowerCase();
  const rows = month.filter(x => (S.filter === 'all' || x.type === S.filter) &&
    (!q || [x.note, catOf(x.category).name, accName(x.account), x.toAccount ? accName(x.toAccount) : ''].some(t => String(t || '').toLowerCase().includes(q))));
  if (!rows.length) { $('#groups').innerHTML = `<div class="card">${emptyBox('🔍', q || S.filter !== 'all' ? '找不到符合的帳目' : '這個月還沒有帳目')}</div>`; return; }
  const groups = new Map(); rows.forEach(x => { if (!groups.has(x.date)) groups.set(x.date, []); groups.get(x.date).push(x); });
  $('#groups').innerHTML = [...groups].map(([d, list]) => {
    const dt = new Date(d + 'T00:00:00'), net = sum(list, 'income') - sum(list, 'expense');
    return `<div class="day-head"><span>${pad(dt.getMonth() + 1)}/${pad(dt.getDate())} 週${WEEK[dt.getDay()]}</span><span>${net ? (net > 0 ? '+' : '-') + money(Math.abs(net)) : ''}</span></div><div class="card list">${list.map(entryRow).join('')}</div>`;
  }).join('');
}

function renderStats() {
  const rows = S.entries.filter(x => monthOf(x.date) === S.month && x.type === S.statType);
  const total = rows.reduce((s, x) => s + x.amount, 0), by = {};
  rows.forEach(x => { by[x.category] = (by[x.category] || 0) + x.amount; });
  let items = Object.entries(by).map(([id, v]) => ({ ...catOf(id), id, v })).sort((a, b) => b.v - a.v);
  if (items.length > 8) { const rest = items.slice(8).reduce((s, i) => s + i.v, 0); items = [...items.slice(0, 8), { icon: '⋯', name: '其他', v: rest }]; }
  items.forEach((it, i) => { it.color = COLORS[i % COLORS.length]; it.pct = total ? it.v / total : 0; });
  const label = S.statType === 'expense' ? '總支出' : '總收入';
  if (!total) {
    $('#donut-card').innerHTML = emptyBox('📊', `這個月沒有${TYPE_LABEL[S.statType]}紀錄`); $('#daily').innerHTML = emptyBox('📈', '沒有資料'); $('#rank').innerHTML = emptyBox('🧾', '沒有資料'); return;
  }
  let acc = 0; const stops = items.map(it => { const s = acc * 100; acc += it.pct; return `${it.color} ${s}% ${acc * 100}%`; }).join(',');
  $('#donut-card').innerHTML = `<div class="donut-wrap"><div class="donut" style="background:conic-gradient(${stops})"><div class="donut-mid"><small>${label}</small><b>${money(total)}</b></div></div>
    <div class="legend">${items.slice(0, 5).map(i => `<div><i style="background:${i.color}"></i><span>${esc(i.name)}</span><em>${Math.round(i.pct * 100)}%</em></div>`).join('')}</div></div>`;
  const [y, mo] = S.month.split('-').map(Number), days = new Date(y, mo, 0).getDate(), perDay = Array(days).fill(0);
  rows.forEach(x => { perDay[Number(x.date.slice(8)) - 1] += x.amount; });
  const max = Math.max(...perDay);
  $('#daily').innerHTML = `<div class="bars">${perDay.map((v, i) => `<i class="${v ? '' : 'zero'}" style="height:${v ? Math.max(4, v / max * 100) : 2}%" title="${i + 1} 日 ${money(v)}"></i>`).join('')}</div><div class="bar-axis"><span>1</span><span>${Math.ceil(days / 2)}</span><span>${days}</span></div>`;
  $('#rank').innerHTML = items.map(i => `<div class="rank-row"><span class="ico" style="background:${i.color}22">${esc(i.icon)}</span><div class="meta"><p>${esc(i.name)}</p></div><span class="amount">${money(i.v)}<small style="color:var(--muted);font-weight:600"> ${Math.round(i.pct * 100)}%</small></span><div class="rank-bar"><i style="width:${i.pct * 100}%;background:${i.color}"></i></div></div>`).join('');
}

const freqLabel = r => r.freq === 'weekly' ? `每週${WEEK[new Date(r.anchor + 'T00:00:00').getDay()]}` : r.freq === 'yearly' ? `每年 ${Number(r.anchor.slice(5, 7))}/${Number(r.anchor.slice(8))}` : `每月 ${Number(r.anchor.slice(8))} 日`;
function renderSettings() {
  const row = (kind, id, label, right, handle, cls = '') => `<div class="setting-row ${cls}" data-row="${kind}" data-id="${esc(id)}">${handle ? '<span class="handle" aria-label="拖曳排序">≡</span>' : ''}<span class="grow">${label}</span><em>${right}</em></div>`;
  $('#account-list').innerHTML = S.accounts.map(a => row('accounts', a.id, esc(a.name), '›', true)).join('');
  $('#category-list').innerHTML = S.cats.map(c => row('categories', c.id, `${esc(c.icon)}　${esc(c.name)}`, '›', true)).join('');
  $('#budget-list').innerHTML = row('budgets', 'total', '💰　每月總預算', S.budgets.total ? money(S.budgets.total) : '未設定', false) +
    S.cats.map(c => row('budgets', c.id, `${esc(c.icon)}　${esc(c.name)}`, S.budgets[c.id] ? money(S.budgets[c.id]) : '未設定', false)).join('');
  $('#recurring-list').innerHTML = S.recurring.length ? S.recurring.map(r => row('recurring', r.id, `${freqLabel(r)}　${r.type === 'transfer' ? '轉帳' : esc(catOf(r.category).icon + ' ' + catOf(r.category).name)}${r.note ? '　' + esc(r.note) : ''}${r.active ? '' : '（已暫停）'}`, money(r.amount), false, r.active ? '' : 'paused')).join('') : '<div class="empty" style="padding:18px">還沒有固定帳目</div>';
  $('#remind-on').checked = S.remind.enabled; $('#remind-time-row').hidden = !S.remind.enabled; $('#remind-time').value = S.remind.time;
  $('#remind-info').textContent = '到了提醒時間若當天還沒記帳，總覽會顯示提醒。Android 安裝版另可收到系統通知（由瀏覽器排程，時間可能略有誤差）；iPhone 目前只能在開啟 App 時提醒。';
  const last = store.get('lastSync'), url = store.get('apiUrl');
  $('#sync-info').textContent = !url ? '填入 URL 後，就能把帳目備份到你的 Google Sheet，並在多台裝置間同步。' : `${S.dirty ? `${S.dirty} 筆變更尚未同步` : '所有資料都已同步'}${last ? `　·　上次同步 ${new Date(last).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}${store.get('syncErr') ? `\n上次同步失敗：${store.get('syncErr')}` : ''}`;
  $('#sync-info').style.whiteSpace = 'pre-line';
  $('#auto-sync').checked = store.get('autoSync') !== '0';
  $('#sync-dot').hidden = !(url && S.dirty);
}

function renderMonthNav() {
  $$('.m-label').forEach(e => { e.textContent = monthLabel(S.month); });
  $$('[data-m="1"]').forEach(b => { b.disabled = S.month >= thisMonth(); });
}
function render() { renderMonthNav(); renderHome(); renderList(); renderStats(); renderSettings(); }

/* ================= 分頁切換 ================= */
function go(tab, quiet) {
  if (!$(`#view-${tab}`)) tab = 'home';
  S.tab = tab; store.set('tab', tab);
  $$('.view').forEach(v => { v.hidden = v.dataset.view !== tab; });
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
  window.scrollTo(0, 0); if (!quiet) buzz(4);
}

/* ================= 匯率（免費公開 API，離線時用上次快取） ================= */
const rateCache = () => { try { return JSON.parse(store.get('rates') || 'null'); } catch { return null; } };
async function loadRates() {
  const c = rateCache(); if (c && Date.now() - c.t < 12 * 36e5) return c;
  if (!navigator.onLine) return c;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/TWD'), j = await r.json();
    if (j.result === 'success') { const n = { t: Date.now(), r: j.rates }; store.set('rates', JSON.stringify(n)); return n; }
  } catch {}
  return c;
}
const rateToTwd = (c, code) => c && c.r && c.r[code] ? Number((1 / c.r[code]).toPrecision(5)) : null;

/* ================= 記帳面板：計算機 + 多幣別 + 重複 ================= */
const sheet = $('#entry-sheet');
const E = { type: 'expense', expr: '', cat: '', cur: 'TWD', old: null, rateEdited: false };

function evalExpr(s) {
  s = s.replace(new RegExp(`[${OPS}.]+$`), ''); if (!s) return 0;
  const nums = s.split(new RegExp(`[${OPS}]`)).map(Number), ops = s.match(new RegExp(`[${OPS}]`, 'g')) || [];
  if (nums.some(n => !Number.isFinite(n))) return NaN;
  const n = [nums[0]], o = [];
  ops.forEach((op, i) => { const v = nums[i + 1]; if (op === '×') n[n.length - 1] *= v; else if (op === '÷') n[n.length - 1] /= v; else { o.push(op); n.push(v); } });
  let r = n[0]; o.forEach((op, i) => { r = op === '+' ? r + n[i + 1] : r - n[i + 1]; });
  return Number.isFinite(r) ? Math.round(r * 100) / 100 : NaN;
}
const hasOp = () => new RegExp(`[${OPS}]`).test(E.expr);
const rateNow = () => Number($('#f-rate').value) || 0;
function renderAmount() {
  const op = hasOp(), val = evalExpr(E.expr);
  const txt = op ? E.expr : E.expr ? (() => { const [i, d] = E.expr.split('.'); return Number(i).toLocaleString('zh-TW') + (d !== undefined ? '.' + d : ''); })() : '0';
  $('#amt').textContent = txt; $('#amt').classList.toggle('ph', !E.expr);
  $('#amt').style.fontSize = txt.length > 14 ? '1.5rem' : txt.length > 10 ? '2rem' : '';
  $('.amount-display').className = `amount-display ${E.type}`;
  const lines = [];
  if (!E.expr && !sheet.classList.contains('kp-open')) lines.push('點一下金額開始輸入');
  if (op) lines.push(Number.isFinite(val) ? `＝ ${fmtNum(val)}` : '算式不正確');
  if (E.cur !== 'TWD' && val > 0 && rateNow() > 0) lines.push(`≈ ${money(Math.round(val * rateNow()))}`);
  $('#approx').hidden = !lines.length; $('#approx').textContent = lines.join('　');
  $('#f-save').textContent = op ? '＝' : E.old ? '儲存變更' : '儲存';
}
const setKp = on => { sheet.classList.toggle('kp-open', on); renderAmount(); if (on) requestAnimationFrame(() => $('.amount-display').scrollIntoView({ block: 'nearest' })); };
function pressKey(k) {
  const seg = E.expr.split(new RegExp(`[${OPS}]`)).pop();
  if (k === 'back') E.expr = E.expr.slice(0, -1);
  else if (OPS.includes(k)) { if (!E.expr) return; E.expr = OPS.includes(E.expr.slice(-1)) ? E.expr.slice(0, -1) + k : E.expr + k; }
  else if (k === '.') { if (seg.includes('.')) return; E.expr += seg === '' ? '0.' : '.'; }
  else { if (seg.replace('.', '').length >= 9) return; E.expr = seg === '0' ? E.expr.slice(0, -1) + k : E.expr + k; }
  renderAmount();
}
function renderSheetType() {
  $$('#type-seg button').forEach(b => b.classList.toggle('on', b.dataset.type === E.type));
  const t = E.type === 'transfer';
  $('#cat-grid').hidden = t; $('#to-row').hidden = !t;
  renderAmount();
}
function renderCats() {
  $('#cat-grid').innerHTML = S.cats.length
    ? S.cats.map(c => `<button class="cat ${c.id === E.cat ? 'on' : ''}" data-cat="${esc(c.id)}"><b>${esc(c.icon)}</b><span>${esc(c.name)}</span></button>`).join('')
    : '<p class="hint">請先到「設定」新增分類。</p>';
}
function fillAccounts() {
  const opts = S.accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  $('#f-account').innerHTML = opts; $('#f-to').innerHTML = opts;
}
async function setCurrency(code, keepRate) {
  E.cur = code; $('#f-cur').value = code; $('#rate-row').hidden = code === 'TWD';
  if (code === 'TWD') return renderAmount();
  $('#rate-label').textContent = `匯率：1 ${code} = ? 元台幣`;
  const apply = c => {
    const r = rateToTwd(c, code);
    if (!keepRate && !E.rateEdited && r) $('#f-rate').value = r;
    $('#rate-hint').textContent = r ? `自動取得${c.t ? `（${new Date(c.t).toLocaleDateString('zh-TW')} 更新）` : ''}，可自行修改` : '無法取得匯率，請手動輸入';
    if (E.cur === code) renderAmount();
  };
  apply(rateCache()); loadRates().then(c => { if (E.cur === code) apply(c); });
}

function openEntry(item, type) {
  fillAccounts();
  E.old = item || null; E.type = item ? item.type : (type || 'expense'); E.rateEdited = !!(item && item.rate);
  E.expr = item ? String(item.currency ? item.foreignAmount : item.amount) : '';
  const lastCat = store.get('lastCat');
  E.cat = item ? (item.type === 'transfer' ? '' : item.category) : (S.cats.some(c => c.id === lastCat) ? lastCat : (S.cats[0] || {}).id || '');
  const lastAcc = store.get('lastAccount');
  $('#f-account').value = item ? item.account : (S.accounts.some(a => a.id === lastAcc) ? lastAcc : S.accounts[0].id);
  $('#f-to').value = item && item.toAccount ? item.toAccount : (S.accounts.find(a => a.id !== $('#f-account').value) || S.accounts[0]).id;
  $('#f-date').value = item ? item.date : todayStr();
  $('#f-note').value = item ? item.note || '' : '';
  $('#f-repeat').value = ''; $('#repeat-row').hidden = !!item;
  $('#f-rate').value = item && item.rate ? item.rate : '';
  $('#sheet-title').textContent = item ? '編輯帳目' : '新增帳目';
  $('#f-delete').hidden = !item;
  sheet.classList.remove('kp-open');
  renderSheetType(); renderCats(); setCurrency(item && item.currency ? item.currency : 'TWD', true);
  openDlg(sheet); $('.sheet-body').scrollTop = 0;
}
const closeEntry = () => closeDlg(sheet);
$('#sheet-close').onclick = closeEntry;
$('#f-cur').innerHTML = CURRENCIES.map(c => `<option value="${c}">${c === 'TWD' ? 'NT$' : c}</option>`).join('');
$('#f-cur').onchange = e => { E.rateEdited = false; $('#f-rate').value = ''; setCurrency(e.target.value); };
$('#f-rate').addEventListener('input', () => { E.rateEdited = true; renderAmount(); });
$('#type-seg').addEventListener('click', e => { const b = e.target.closest('[data-type]'); if (!b) return; E.type = b.dataset.type; buzz(); renderSheetType(); });
$('#cat-grid').addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (!b) return; E.cat = b.dataset.cat; buzz(); renderCats(); });
$('.amount-display').addEventListener('click', e => { if (e.target.closest('select')) return; buzz(6); setKp(!sheet.classList.contains('kp-open')); });
$('#kp-hide').onclick = () => setKp(false);
$('.sheet-body').addEventListener('focusin', e => { if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) setKp(false); }); // 要打字時收起數字鍵盤，避免和系統鍵盤打架
$('#keypad').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (!b) return; buzz(6); pressKey(b.dataset.k); });
document.addEventListener('keydown', e => { // 桌機鍵盤也能輸入
  if (!sheet.open || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  const map = { '*': '×', '/': '÷', '-': MINUS, '+': '+', '.': '.' };
  if (/^\d$/.test(e.key)) pressKey(e.key); else if (map[e.key]) pressKey(map[e.key]);
  else if (e.key === 'Backspace') pressKey('back'); else if (e.key === 'Enter' || e.key === '=') saveEntry();
});
$('#f-note').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

function reject(msg) { toast(msg); buzz([30, 40, 30]); const a = $('.amount-display'); a.classList.remove('shake'); void a.offsetWidth; a.classList.add('shake'); }
async function saveEntry() {
  if (hasOp()) { // 先算出結果，再按一次才儲存
    const v = evalExpr(E.expr); if (!(v > 0)) return reject(Number.isFinite(v) ? '金額必須大於 0' : '算式不正確');
    E.expr = String(v); buzz(6); return renderAmount();
  }
  const val = evalExpr(E.expr), account = $('#f-account').value, to = $('#f-to').value, date = $('#f-date').value, foreign = E.cur !== 'TWD', rate = rateNow();
  if (!(val > 0)) { setKp(true); return reject('請輸入金額'); }
  if (foreign && !(rate > 0)) return reject('請輸入匯率');
  if (E.type === 'transfer' ? account === to : !E.cat) return reject(E.type === 'transfer' ? '轉出與轉入帳戶不能相同' : '請選擇分類');
  if (!date) return reject('請選擇日期');
  const amount = foreign ? Math.round(val * rate) : Math.round(val);
  if (amount <= 0) return reject('換算後金額太小');
  const old = E.old, now = nowISO();
  const entry = {
    id: old ? old.id : uid(), date, type: E.type, account, toAccount: E.type === 'transfer' ? to : '',
    category: E.type === 'transfer' ? 'transfer' : E.cat, amount, note: $('#f-note').value.trim(),
    createdAt: old ? old.createdAt : now, updatedAt: now, ...(foreign ? { currency: E.cur, foreignAmount: val, rate } : {})
  };
  await put('entries', entry);
  const freq = old ? '' : $('#f-repeat').value;
  if (freq) await put('recurring', { id: uid(), type: entry.type, account, toAccount: entry.toAccount, category: entry.category, amount, note: entry.note, ...(foreign ? { currency: E.cur, foreignAmount: val, rate } : {}), freq, anchor: date, lastRun: date, active: true, updatedAt: now });
  store.set('lastAccount', account); if (E.type !== 'transfer') store.set('lastCat', E.cat);
  buzz(15); closeEntry();
  if (!old) S.month = date.slice(0, 7);
  await commit();
  const warn = budgetAlert(entry, old);
  toast(warn || (freq ? '已記下，並建立固定帳目' : old ? '已更新帳目' : '已記下一筆'));
  if (warn) buzz([20, 60, 20]);
}
$('#f-save').onclick = saveEntry;
$('#f-delete').onclick = () => { const it = E.old; closeEntry(); setTimeout(() => removeEntry(it), 260); };

async function removeEntry(item) {
  if (!item) return;
  await kill('entries', item); buzz(12); await commit();
  toast('已刪除帳目', { label: '復原', fn: async () => { await put('entries', { ...item, updatedAt: nowISO() }); await commit(); } });
}

/* ================= 固定帳目：到期自動入帳 ================= */
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return ymd(x); };
function addMonths(anchor, k) {
  const [y, m, d] = anchor.split('-').map(Number), t = new Date(y, m - 1 + k, 1), dim = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  return ymd(new Date(t.getFullYear(), t.getMonth(), Math.min(d, dim)));
}
const nthDate = (r, k) => r.freq === 'weekly' ? addDays(r.anchor, 7 * k) : r.freq === 'yearly' ? addMonths(r.anchor, 12 * k) : addMonths(r.anchor, k);
async function runRecurring() {
  const today = todayStr(), ids = new Set(S.rawEntries.map(x => x.id)), entries = [], rules = [], now = nowISO();
  for (const r of S.recurring) {
    if (!r.active) continue;
    let last = r.lastRun || r.anchor, moved = false;
    for (let k = 1; k < 600; k++) {
      const d = nthDate(r, k); if (d > today) break; if (d <= last) continue;
      const id = `r_${r.id}_${d}`; // 固定 ID：多台裝置同時產生也不會重複
      if (!ids.has(id)) entries.push({ id, date: d, type: r.type, account: r.account, toAccount: r.toAccount || '', category: r.category, amount: r.amount, note: r.note || '', createdAt: now, updatedAt: now, ...(r.currency ? { currency: r.currency, foreignAmount: r.foreignAmount, rate: r.rate } : {}) });
      last = d; moved = true;
    }
    if (moved) rules.push({ ...r, lastRun: last, updatedAt: now });
  }
  if (!rules.length) return;
  await putMany('entries', entries); await putMany('recurring', rules);
  await commit(); if (entries.length) toast(`已自動記入 ${entries.length} 筆固定帳目`);
}

/* ================= 列表手勢：左滑刪除 ================= */
const OPEN = 84; let sw = null, swiped = false;
const peek = (el, on) => { const s = el.parentNode; if (on) s.classList.add('peek'); else setTimeout(() => { if (!el.classList.contains('open')) s.classList.remove('peek'); }, 240); };
const closeSwipes = except => $$('.entry.open').forEach(e => { if (e !== except) { e.classList.remove('open'); peek(e, false); } });
document.addEventListener('pointerdown', e => {
  swiped = false; if (e.target.closest('[data-del]')) return;
  const el = e.target.closest('.entry');
  if (!el) return closeSwipes();
  closeSwipes(el); sw = { el, x: e.clientX, y: e.clientY, dx: 0, moved: false, base: el.classList.contains('open') ? -OPEN : 0 };
});
document.addEventListener('pointermove', e => {
  if (!sw) return; const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
  if (!sw.moved) { if (Math.abs(dx) < 8) return; if (Math.abs(dy) > Math.abs(dx)) { sw = null; return; } sw.moved = true; sw.el.style.transition = 'none'; peek(sw.el, true); }
  sw.dx = dx; sw.el.style.transform = `translateX(${Math.max(-OPEN - 24, Math.min(0, sw.base + dx))}px)`;
});
const swEnd = () => {
  if (!sw) return; const { el, moved, base, dx } = sw; sw = null; if (!moved) return;
  const open = base + dx < -OPEN / 2;
  swiped = true; el.style.transition = ''; el.style.transform = ''; el.classList.toggle('open', open); peek(el, open); if (open) buzz(6);
};
document.addEventListener('pointerup', swEnd); document.addEventListener('pointercancel', swEnd);

/* ================= 設定列：拖曳排序 ================= */
let ro = null;
document.addEventListener('pointerdown', e => {
  const h = e.target.closest('.handle'); if (!h) return;
  const row = h.closest('.setting-row'); ro = { row, box: row.parentNode, kind: row.dataset.row, moved: false };
  row.classList.add('dragging'); h.setPointerCapture(e.pointerId); buzz(8);
});
document.addEventListener('pointermove', e => {
  if (!ro) return; ro.moved = true;
  const others = [...ro.box.children].filter(r => r !== ro.row); let before = null;
  for (const r of others) { const b = r.getBoundingClientRect(); if (e.clientY < b.top + b.height / 2) { before = r; break; } }
  if (ro.row.nextSibling !== before) ro.box.insertBefore(ro.row, before);
});
async function roEnd() {
  if (!ro) return; const { row, box, kind, moved } = ro; ro = null; row.classList.remove('dragging'); if (!moved) return;
  const list = kind === 'accounts' ? S.accounts : S.cats, now = nowISO();
  const items = [...box.children].map((r, i) => ({ ...list.find(x => x.id === r.dataset.id), order: (i + 1) * 10, updatedAt: now })).filter(x => x.id);
  await putMany(kind, items); buzz(10); commit();
}
document.addEventListener('pointerup', roEnd); document.addEventListener('pointercancel', roEnd);

/* ================= 點擊事件（統一委派） ================= */
document.addEventListener('click', e => {
  if (swiped) { swiped = false; return; }
  const t = e.target; let n;
  if ((n = t.closest('[data-del]'))) return removeEntry(S.entries.find(x => x.id === n.dataset.del));
  if ((n = t.closest('[data-edit]'))) { if (n.classList.contains('open')) { n.classList.remove('open'); return peek(n, false); } return openEntry(S.entries.find(x => x.id === n.dataset.edit)); }
  if ((n = t.closest('[data-tab]'))) return go(n.dataset.tab);
  if ((n = t.closest('[data-m]'))) { const next = shiftMonth(S.month, Number(n.dataset.m)); if (next <= thisMonth()) { S.month = next; render(); buzz(4); } return; }
  if ((n = t.closest('[data-f]'))) { S.filter = n.dataset.f; $$('#filters .chip').forEach(c => c.classList.toggle('on', c === n)); return renderList(); }
  if ((n = t.closest('[data-st]'))) { S.statType = n.dataset.st; $$('#stat-type button').forEach(c => c.classList.toggle('on', c === n)); return renderStats(); }
  if (t.closest('.handle')) return;
  if ((n = t.closest('[data-row]'))) return editRow(n.dataset.row, n.dataset.id);
});
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.entry')) { e.preventDefault(); e.target.click(); } });
$('#add-btn').onclick = () => { buzz(10); openEntry(null); };
$('#remind').onclick = () => openEntry(null);
$('#search').addEventListener('input', e => { S.q = e.target.value; renderList(); });

/* ================= 帳戶 / 分類 / 預算 / 固定帳目 編輯 ================= */
$('#account-form').onsubmit = async e => {
  e.preventDefault(); const name = new FormData(e.target).get('name').trim();
  if (!name) return; await put('accounts', { id: uid(), name, order: Date.now(), updatedAt: nowISO() }); e.target.reset(); toast('已新增帳戶'); commit();
};
$('#category-form').onsubmit = async e => {
  e.preventDefault(); const v = Object.fromEntries(new FormData(e.target)), name = v.name.trim();
  if (!name) return; await put('categories', { id: uid(), name, icon: v.icon.trim() || '🏷️', order: Date.now(), updatedAt: nowISO() }); e.target.reset(); e.target.icon.value = '🏷️'; toast('已新增分類'); commit();
};
function editRow(kind, id) {
  if (kind === 'accounts') {
    const a = S.accounts.find(x => x.id === id); if (!a) return;
    openForm({
      title: '編輯帳戶', fields: [{ k: 'name', label: '名稱', value: a.name, attrs: 'maxlength="20" required' }],
      onSave: async v => { if (!v.name.trim()) return false; await put('accounts', { ...a, name: v.name.trim(), updatedAt: nowISO() }); commit(); },
      onDelete: S.accounts.length > 1 ? async () => {
        if (S.entries.some(x => x.account === id || x.toAccount === id)) { toast('這個帳戶已有帳目，無法刪除'); return false; }
        if (!confirm(`刪除帳戶「${a.name}」？`)) return false; await kill('accounts', a); commit();
      } : null
    });
  } else if (kind === 'categories') {
    const c = S.cats.find(x => x.id === id); if (!c) return;
    openForm({
      title: '編輯分類', fields: [{ k: 'icon', label: '圖示（一個 emoji）', value: c.icon, attrs: 'maxlength="4" required' }, { k: 'name', label: '名稱', value: c.name, attrs: 'maxlength="20" required' }],
      onSave: async v => { if (!v.name.trim()) return false; await put('categories', { ...c, name: v.name.trim(), icon: v.icon.trim() || '🏷️', updatedAt: nowISO() }); commit(); },
      onDelete: async () => {
        const used = S.entries.filter(x => x.category === id).length;
        if (!confirm(used ? `「${c.name}」已被 ${used} 筆帳目使用，刪除後這些帳目仍會保留。確定刪除？` : `刪除分類「${c.name}」？`)) return false;
        await kill('categories', c); commit();
      }
    });
  } else if (kind === 'budgets') {
    const name = id === 'total' ? '每月總預算' : `${catOf(id).name}預算`, cur = S.budgets[id];
    openForm({
      title: name, note: id === 'total' ? '整個月所有支出的上限。' : '這個分類每月的支出上限。留空或 0 代表不設定。',
      fields: [{ k: 'amount', label: '每月金額（元）', type: 'number', value: cur || '', placeholder: '不設定', attrs: 'min="0" step="1" inputmode="numeric"' }],
      onSave: async v => { const n = Math.round(Number(v.amount) || 0); await put('budgets', n > 0 ? { id, amount: n, updatedAt: nowISO() } : { id, amount: 0, deleted: true, updatedAt: nowISO() }); commit(); },
      onDelete: cur ? async () => { await put('budgets', { id, amount: 0, deleted: true, updatedAt: nowISO() }); commit(); } : null, deleteLabel: '清除'
    });
  } else if (kind === 'recurring') {
    const r = S.recurring.find(x => x.id === id); if (!r) return;
    openForm({
      title: '固定帳目', note: `${freqLabel(r)} · 到期會自動入帳，已入帳的不會更動。`,
      fields: [{ k: 'amount', label: '金額（台幣）', type: 'number', value: r.amount, attrs: 'min="1" step="1" inputmode="numeric" required' }, { k: 'note', label: '備註', value: r.note || '', attrs: 'maxlength="100"' },
        { k: 'active', label: '狀態', type: 'select', value: r.active ? '1' : '0', options: [['1', '執行中'], ['0', '暫停']] }],
      onSave: async v => { const n = Math.round(Number(v.amount)); if (!(n > 0)) return false; await put('recurring', { ...r, amount: n, note: v.note.trim(), active: v.active === '1', updatedAt: nowISO() }); await commit(); runRecurring(); },
      onDelete: async () => { if (!confirm('刪除這個固定帳目？已入帳的紀錄會保留。')) return false; await kill('recurring', r); commit(); }, deleteLabel: '刪除'
    });
  }
}

/* ================= 每日提醒 ================= */
async function saveRemind() { await put('meta', S.remind); render(); }
$('#remind-on').onchange = async e => {
  S.remind.enabled = e.target.checked; await saveRemind();
  if (!S.remind.enabled) return;
  let perm = 'unsupported';
  if ('Notification' in window) { perm = Notification.permission; if (perm === 'default') perm = await Notification.requestPermission(); }
  try {
    const reg = await navigator.serviceWorker.ready;
    if (perm === 'granted' && 'periodicSync' in reg) await reg.periodicSync.register('daily-reminder', { minInterval: 12 * 3600 * 1000 });
  } catch {}
  toast(perm === 'granted' ? '提醒已開啟' : '已開啟 App 內提醒（未授權系統通知）');
};
$('#remind-time').onchange = async e => { S.remind.time = e.target.value || '21:00'; await saveRemind(); };

/* ================= 同步（雙向、依更新時間取新者） ================= */
function bridge(url, payload) {
  return new Promise((ok, bad) => {
    const f = document.createElement('iframe'), id = uid();
    const timer = setTimeout(() => done(null, Error('連線逾時，請確認 Apps Script URL、登入狀態與部署權限。')), 30000);
    f.hidden = true;
    function done(v, err) { clearTimeout(timer); window.removeEventListener('message', recv); f.remove(); err ? bad(err) : ok(v); }
    let target = null;
    const fromGoogle = o => { try { return /(^|\.)(google\.com|googleusercontent\.com)$/.test(new URL(o).hostname); } catch { return false; } };
    function recv(e) {
      const m = e.data || {};
      if (m.app !== 'line-ledger' || !fromGoogle(e.origin)) return;
      if (m.ready) { // 橋接頁載入完成：用它自己的視窗回傳資料（Google 外框會擋住直接傳給 iframe）
        if (target) return; target = e.source;
        target.postMessage({ app: 'line-ledger', id, action: 'sync', entries: payload.entries, payload }, '*'); return;
      }
      if (m.id !== id || e.source !== target) return;
      done(m.payload, m.payload && m.payload.ok ? null : Error((m.payload && m.payload.error) || '同步失敗。'));
    }
    window.addEventListener('message', recv);
    f.src = url; document.body.append(f);
  });
}
const KINDS = ['accounts', 'categories', 'budgets', 'recurring'];
async function collect() {
  const records = [];
  for (const kind of KINDS) (await all(kind)).forEach(x => records.push({ kind, id: x.id, updatedAt: x.updatedAt || EPOCH, deleted: !!x.deleted, data: x }));
  return { entries: await all('entries'), records };
}
async function applyRemote(r) {
  let pulled = 0; const newer = (a, b) => (a.updatedAt || '') > ((b && b.updatedAt) || '');
  if (Array.isArray(r.entries)) {
    const local = new Map((await all('entries')).map(x => [x.id, x])), take = r.entries.filter(x => newer(x, local.get(x.id)));
    await putMany('entries', take); pulled += take.length;
  }
  if (Array.isArray(r.records)) {
    for (const kind of KINDS) {
      const local = new Map((await all(kind)).map(x => [x.id, x]));
      const take = r.records.filter(x => x.kind === kind && newer(x, local.get(x.id))).map(x => ({ ...x.data, id: x.id, deleted: !!x.deleted, updatedAt: x.updatedAt }));
      await putMany(kind, take); pulled += take.length;
    }
  }
  return pulled;
}
let syncing = false;
function setBusy(b) {
  syncing = b; $('#sync-btn').classList.toggle('spin', b); $('#sync-now').disabled = b; $('#sync-now').textContent = b ? '同步中…' : '立即同步';
}
async function doSync(silent) {
  if (syncing) return;
  const url = (store.get('apiUrl') || '').trim();
  if (silent && (!url || !navigator.onLine || store.get('autoSync') === '0')) return;
  if (!url) { toast('請先到「設定」填入 Apps Script URL'); go('settings'); return; }
  if (!navigator.onLine) return toast('目前離線，連上網路後再同步');
  setBusy(true); const startedAt = nowISO();
  try {
    const r = await bridge(url, await collect()), pulled = await applyRemote(r);
    store.set('lastSync', startedAt); store.set('syncErr', ''); await load();
    if (!silent) { buzz(15); toast(r.entries ? `同步完成：上傳 ${r.saved} 筆、下載 ${pulled} 筆更新` : `已上傳 ${r.saved} 筆（後端為舊版，請更新 Apps Script 以啟用雙向同步）`); }
    else if (pulled) toast(`已從雲端更新 ${pulled} 筆資料`);
  } catch (err) { store.set('syncErr', err.message); if (!silent) toast(`同步失敗：${err.message}`); }
  setBusy(false); renderSettings();
}
$('#sync-btn').onclick = () => doSync(); $('#sync-now').onclick = () => doSync();
$('#api-url').value = store.get('apiUrl') || '';
$('#api-url').onchange = e => { store.set('apiUrl', e.target.value.trim()); renderSettings(); };
$('#auto-sync').onchange = e => { store.set('autoSync', e.target.checked ? '1' : '0'); };

/* 下拉同步 */
let pull = null; const ptr = $('#ptr');
addEventListener('touchstart', e => { if (window.scrollY > 0 || $('dialog[open]') || syncing || e.touches.length !== 1) { pull = null; return; } pull = { x: e.touches[0].clientX, y: e.touches[0].clientY, d: 0 }; ptr.style.transition = 'none'; }, { passive: true });
addEventListener('touchmove', e => {
  if (!pull) return; const dy = e.touches[0].clientY - pull.y, dx = e.touches[0].clientX - pull.x;
  if (dy <= 0 || Math.abs(dx) > dy) { pull.d = 0; return; }
  pull.d = Math.min(dy, 140); ptr.style.opacity = Math.min(1, pull.d / 70); ptr.style.transform = `translateY(${pull.d * .55 - 60}px) rotate(${pull.d * 3}deg)`;
}, { passive: true });
addEventListener('touchend', () => {
  if (!pull) return; const fire = pull.d > 90; pull = null;
  if (fire) {
    ptr.style.transition = '.2s'; ptr.style.opacity = 1; ptr.style.transform = 'translateY(0)'; ptr.classList.add('go');
    doSync().finally(() => { ptr.style.opacity = 0; ptr.style.transform = 'translateY(-60px)'; ptr.classList.remove('go'); });
  } else { ptr.style.transition = '.2s'; ptr.style.opacity = 0; ptr.style.transform = 'translateY(-60px)'; }
});

/* ================= 備份 / 還原 ================= */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#export-json').onclick = async () => {
  const d = { app: 'ledger', version: 2, exportedAt: nowISO() };
  for (const k of ['entries', 'accounts', 'categories', 'budgets', 'recurring']) d[k] = (await all(k)).filter(live);
  download(`記帳備份-${todayStr()}.json`, JSON.stringify(d, null, 2), 'application/json'); toast('已匯出備份');
};
$('#export-csv').onclick = () => {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['日期', '類型', '帳戶', '轉入帳戶', '分類', '金額(台幣)', '幣別', '外幣金額', '匯率', '備註'], ...[...S.entries].reverse().map(x => [x.date, TYPE_LABEL[x.type], accName(x.account), x.toAccount ? accName(x.toAccount) : '', x.type === 'transfer' ? '' : catOf(x.category).name, x.amount, x.currency || '', x.foreignAmount || '', x.rate || '', x.note])];
  download(`記帳-${todayStr()}.csv`, '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n'), 'text/csv'); toast('已匯出 CSV');
};
$('#import-btn').onclick = () => $('#import-file').click();
$('#import-file').onchange = async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  try {
    const d = JSON.parse(await file.text()), now = nowISO(), stamp = list => (list || []).map(x => ({ ...x, updatedAt: x.updatedAt || now }));
    const okE = x => x && x.id && /^\d{4}-\d{2}-\d{2}$/.test(x.date) && TYPE_LABEL[x.type] && Number(x.amount) > 0;
    const entries = stamp(d.entries).filter(okE), accounts = stamp(d.accounts).filter(a => a.id && a.name), cats = stamp(d.categories).filter(c => c.id && c.name);
    if (!entries.length && !accounts.length) throw Error('找不到可還原的資料');
    if (!confirm(`將還原 ${entries.length} 筆帳目、${accounts.length} 個帳戶、${cats.length} 個分類。\n相同 ID 的資料會被覆蓋，其他現有資料不會刪除。`)) return;
    await Promise.all([putMany('entries', entries.map(x => ({ ...x, updatedAt: now, deleted: false }))), putMany('accounts', accounts), putMany('categories', cats), putMany('budgets', stamp(d.budgets)), putMany('recurring', stamp(d.recurring))]);
    await commit(); toast('還原完成');
  } catch (err) { toast(`還原失敗：${err.message}`); }
};

/* ================= 安裝 / 離線 / 更新 ================= */
let installEvt;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#install-btn').hidden = false; });
$('#install-btn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#install-btn').hidden = true; };
addEventListener('appinstalled', () => { $('#install-btn').hidden = true; toast('已安裝到主畫面'); });
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) $('#ios-hint').hidden = false;
const netUI = () => { $('#offline').hidden = navigator.onLine; };
addEventListener('online', () => { netUI(); touched(); }); addEventListener('offline', netUI); netUI();
let lastActive = Date.now();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  if (S.month > thisMonth()) S.month = thisMonth();
  await load(); await runRecurring();
  if (Date.now() - lastActive > 5 * 60 * 1000) doSync(true);
  lastActive = Date.now();
});

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller; let reloading = false;
  const offer = w => toast('有新版本可使用', { label: '更新', sticky: true, fn: () => w.postMessage('SKIP_WAITING') });
  navigator.serviceWorker.register('./sw.js').then(reg => {
    if (reg.waiting && hadController) offer(reg.waiting);
    reg.addEventListener('updatefound', () => { const w = reg.installing; w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); }); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hadController || reloading) return; reloading = true; location.reload(); });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); // 避免瀏覽器在空間不足時清掉帳本

/* iPhone 全螢幕模式：若系統回報的瀏海高度是 0（部分 iOS 版本的已知問題），用保底值避免標題被瀏海／狀態列蓋住 */
(() => {
  if (!(/iphone|ipad|ipod/i.test(navigator.userAgent) && standalone)) return;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;padding-top:env(safe-area-inset-top);visibility:hidden';
  document.body.append(probe);
  const inset = parseFloat(getComputedStyle(probe).paddingTop) || 0; probe.remove();
  if (inset < 20) document.documentElement.style.setProperty('--st-min', '47px');
  // 底部導覽列改用「從頂端算起」的位置：這台 iPhone 的 bottom:0 會停在螢幕底部上方約 47pt，但 top 是準的
  const root = document.documentElement; root.classList.add('ios-pwa');
  const full = () => { if (innerHeight > innerWidth) root.style.setProperty('--full-h', `${Math.max(innerHeight, screen.height)}px`); };
  full(); addEventListener('resize', full); addEventListener('pageshow', full); addEventListener('orientationchange', () => setTimeout(full, 300));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { full(); setTimeout(full, 400); } });
})();

/* ================= 主題色 ================= */
const THEMES = [['green', '森林綠', '#147b4d'], ['blue', '海洋藍', '#2563eb'], ['purple', '薰衣草', '#7c4dff'], ['pink', '蜜桃粉', '#e0568a'], ['orange', '夕陽橘', '#e0701f'], ['slate', '石墨灰', '#475569']];
function applyTheme(id) {
  const t = THEMES.find(x => x[0] === id) || THEMES[0];
  document.documentElement.dataset.theme = t[0];
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = getComputedStyle(document.documentElement).getPropertyValue('--hero2').trim() || t[2];
  $$('#theme-list button').forEach(b => b.classList.toggle('on', b.dataset.theme === t[0]));
}
$('#theme-list').innerHTML = THEMES.map(([id, name, c]) => `<button data-theme="${id}" aria-label="${name}"><i style="background:${c}"></i><span>${name}</span></button>`).join('');
$('#theme-list').addEventListener('click', e => { const b = e.target.closest('[data-theme]'); if (!b) return; store.set('theme', b.dataset.theme); buzz(); applyTheme(b.dataset.theme); });
applyTheme(store.get('theme') || 'green');

/* ================= 啟動 ================= */
const dbg = () => { // 除錯資訊：版本 · 視窗高/螢幕高 · 導覽列底邊位置 · 底部安全區 · visualViewport 高/偏移
  const p = document.createElement('div'); p.style.cssText = 'position:fixed;bottom:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden'; document.body.append(p);
  const env = parseFloat(getComputedStyle(p).paddingBottom) || 0, eb = Math.round(p.getBoundingClientRect().bottom); p.remove();
  const nb = Math.round(document.querySelector('.tabbar').getBoundingClientRect().bottom), vv = window.visualViewport;
  $('#ver').textContent = `v${VERSION} · ${innerHeight}/${screen.height} · nav${nb} fix${eb} env${env} vv${vv ? Math.round(vv.height) + '/' + Math.round(vv.offsetTop) : '-'}`;
};
dbg(); setTimeout(dbg, 1500); document.addEventListener('visibilitychange', () => setTimeout(dbg, 300)); $('#ver').onclick = dbg;
seed().then(load).then(async () => {
  go(store.get('tab') || 'home', true);
  await runRecurring();
  doSync(true);
  const add = new URLSearchParams(location.search).get('add');
  if (add) { history.replaceState(null, '', location.pathname); openEntry(null, TYPE_LABEL[add] ? add : 'expense'); }
});
