// 一起打卡吧 · 纯前端版本（localStorage 代替后端，无 WebSocket）
// 与 app.js 共用 style.css，仅替换数据层与渲染触发方式。
const app = document.getElementById('app');
let currentToken = null;
let currentParticipant = null;
let cachedState = null;
let dragId = null;

const COLORS = ['#e63946', '#2563eb', '#f59e0b', '#16a34a', '#7c3aed', '#db2777'];
const genToken = () => Math.random().toString(36).slice(2, 14);
const genId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const colorFor = (i) => COLORS[i % COLORS.length];

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const initials = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

const toast = (msg) => {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
};

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const t = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${t}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function fmtRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  return fmtDate(ts);
}

// 客户端压缩图片
function resizeImage(file, maxDim = 1100, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- localStorage 数据层 ----------
// daka:lists => { [token]: { list, participants, items } }
const LISTS_KEY = 'daka:lists';
const loadLists = () => { try { return JSON.parse(localStorage.getItem(LISTS_KEY) || '{}'); } catch { return {}; } };
const saveLists = (m) => localStorage.setItem(LISTS_KEY, JSON.stringify(m));
const getList = (token) => loadLists()[token] || null;
const persistEntry = (token, entry) => { const m = loadLists(); m[token] = entry; saveLists(m); };

// 1. 创建清单：生成 token，创建 list 对象，添加创建者为第一个参与者
function createList({ name, creatorName, mode, targetCount }) {
  const token = genToken();
  const listId = genId();
  const pId = genId();
  const now = Date.now();
  const tc = Math.max(1, Math.min(999, parseInt(targetCount, 10) || 1));
  const list = {
    id: listId,
    name: (name || '').trim() || '我们的打卡清单',
    token, mode: mode === 'solo' ? 'solo' : 'collab',
    targetCount: tc, status: 'active', endedAt: null, createdAt: now
  };
  const participants = [{
    id: pId, listId, name: (creatorName || '').trim() || '发起人',
    color: colorFor(0), joinedAt: now
  }];
  const entry = { list, participants, items: [] };
  persistEntry(token, entry);
  return { listId, token, participantId: pId, mode: list.mode, targetCount: tc };
}

// 2. 获取清单状态：返回 list, participants, items（派生 completed/completedAt）
function getState(token) {
  const entry = getList(token);
  if (!entry) return null;
  const { list, participants, items } = entry;
  const pIds = new Set(participants.map((p) => p.id));
  const itemsView = items.map((i) => {
    const confirmations = {};
    for (const k in (i.confirmations || {})) if (pIds.has(k)) confirmations[k] = i.confirmations[k];
    const confirmedCount = Object.keys(confirmations).length;
    const completed = participants.length > 0 && confirmedCount === participants.length;
    const completedAt = completed && confirmedCount > 0 ? Math.max(...Object.values(confirmations)) : null;
    return {
      id: i.id, content: i.content, createdBy: i.createdBy, createdAt: i.createdAt,
      order: i.order ?? 0, image: i.image || null, confirmations, completed, completedAt
    };
  });
  return { list, participants, items: itemsView };
}

// 3. 加入清单：添加新参与者
function joinList({ token, name }) {
  const entry = getList(token);
  if (!entry) return null;
  const n = (name || '').trim() || '好友';
  const existing = entry.participants.find((p) => p.name === n);
  if (existing) return existing.id;
  const pId = genId();
  entry.participants.push({
    id: pId, listId: entry.list.id, name: n,
    color: colorFor(entry.participants.length), joinedAt: Date.now()
  });
  persistEntry(token, entry);
  return pId;
}

// 4. 添加任务
function addItem({ token, content, participantId }) {
  const entry = getList(token);
  if (!entry) return null;
  if (entry.list.status === 'ended') return { error: 'ended' };
  const id = genId();
  entry.items.push({
    id, listId: entry.list.id, content: (content || '').trim(),
    createdBy: participantId || null, createdAt: Date.now(),
    order: entry.items.length, image: null, confirmations: {}
  });
  persistEntry(token, entry);
  return id;
}

// 5. 设置图片（base64）
function setItemImage({ token, itemId, image }) {
  const entry = getList(token);
  if (!entry) return false;
  const it = entry.items.find((i) => i.id === itemId);
  if (!it) return false;
  it.image = image || null;
  persistEntry(token, entry);
  return true;
}

// 6. 切换确认：确认前需要有图片
function toggleConfirm({ token, itemId, participantId }) {
  const entry = getList(token);
  if (!entry) return null;
  const it = entry.items.find((i) => i.id === itemId);
  if (!it) return null;
  if (!it.confirmations) it.confirmations = {};
  if (!it.confirmations[participantId] && !it.image) return { error: 'need_image' };
  if (it.confirmations[participantId]) delete it.confirmations[participantId];
  else it.confirmations[participantId] = Date.now();
  persistEntry(token, entry);
  return { ok: true };
}

// 7. 排序
function reorderItems({ token, orderedIds }) {
  const entry = getList(token);
  if (!entry) return false;
  orderedIds.forEach((id, idx) => {
    const it = entry.items.find((i) => i.id === id);
    if (it) it.order = idx;
  });
  entry.items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  persistEntry(token, entry);
  return true;
}

// 8. 删除任务
function deleteItem({ token, itemId }) {
  const entry = getList(token);
  if (!entry) return false;
  const idx = entry.items.findIndex((i) => i.id === itemId);
  if (idx < 0) return false;
  entry.items.splice(idx, 1);
  persistEntry(token, entry);
  return true;
}

// 9. 结束清单
function endList({ token }) {
  const entry = getList(token);
  if (!entry) return false;
  if (entry.list.status === 'ended') return false;
  entry.list.status = 'ended';
  entry.list.endedAt = Date.now();
  persistEntry(token, entry);
  return true;
}

// ---------- 参与者信息 & 历史记录 ----------
// daka:p:{token} => { id, name }
const pKey = (token) => `daka:p:${token}`;
const loadP = (token) => { try { return JSON.parse(localStorage.getItem(pKey(token)) || 'null'); } catch { return null; } };
const saveP = (token, p) => localStorage.setItem(pKey(token), JSON.stringify(p));

// daka:mylists => [{ token, name, role, mode, addedAt, lastSeenAt }]
const MY_KEY = 'daka:mylists';
const getMyLists = () => { try { return JSON.parse(localStorage.getItem(MY_KEY) || '[]'); } catch { return []; } };
const saveMyLists = (arr) => localStorage.setItem(MY_KEY, JSON.stringify(arr));
function trackList(token, name, role, mode) {
  const arr = getMyLists();
  const e = arr.find((x) => x.token === token);
  if (e) { e.name = name; e.role = role; e.mode = mode; e.lastSeenAt = Date.now(); }
  else arr.unshift({ token, name, role, mode, addedAt: Date.now(), lastSeenAt: Date.now() });
  saveMyLists(arr);
}
function touchList(token) {
  const arr = getMyLists();
  const e = arr.find((x) => x.token === token);
  if (e) { e.lastSeenAt = Date.now(); saveMyLists(arr); }
}
function untrackList(token) {
  saveMyLists(getMyLists().filter((x) => x.token !== token));
}

// ---------- router ----------
function route() {
  const hash = location.hash.slice(1) || '/';
  const albumM = hash.match(/^\/album\/([\w-]+)/);
  if (albumM) return openAlbum(albumM[1]);
  const listM = hash.match(/^\/l\/([\w-]+)/);
  if (listM) return openList(listM[1]);
  renderHome();
}
window.addEventListener('hashchange', route);

// ---------- home ----------
function renderHome() {
  currentToken = null;
  const mine = getMyLists();
  const hasHistory = mine.length > 0;

  app.innerHTML = `
    <div class="home">
      <div class="home-head">
        <div class="badge"><span class="dot"></span> 我的打卡台</div>
        <h1>一起<span class="red">打卡</span>吧</h1>
        <p class="sub">设定目标，共同完成，留下回忆。<b>单人</b>自己打卡，<b>协作</b>邀请好友一起确认。数据保存在本机浏览器。</p>
        <button class="btn blue" id="newBtn">＋ 创建新清单</button>
      </div>

      <div class="create-section" id="createSection" style="${hasHistory ? 'display:none' : ''}">
        ${createFormHtml()}
      </div>

      <div class="history-section" id="historySection" style="${hasHistory ? '' : 'display:none'}">
        <h2 class="section-title">我的清单 <span class="count">${mine.length}</span></h2>
        <div id="historyGrid" class="history-grid"></div>
      </div>
    </div>`;

  bindCreateForm();
  $('#newBtn').addEventListener('click', () => {
    const sec = $('#createSection');
    const show = sec.style.display === 'none';
    sec.style.display = show ? '' : 'none';
    $('#newBtn').textContent = show ? '收起创建' : '＋ 创建新清单';
    if (show) $('#listName', sec)?.focus();
  });

  if (hasHistory) loadHistory();
}

function createFormHtml() {
  return `
    <form class="create-card" id="createForm">
      <div class="field">
        <label>清单名称</label>
        <input id="listName" type="text" maxlength="40" placeholder="30 天运动挑战 / 读书会 / 早起联盟" required />
      </div>
      <div class="field">
        <label>你的名字</label>
        <input id="creatorName" type="text" maxlength="16" placeholder="小明" required />
      </div>
      <div class="field">
        <label>目标：打算完成几件事？</label>
        <div class="target-row">
          <button type="button" class="target-btn" data-d="-1">−</button>
          <input id="targetCount" type="number" min="1" max="999" value="5" />
          <button type="button" class="target-btn" data-d="1">＋</button>
          <span class="target-hint">件</span>
        </div>
      </div>
      <div class="field">
        <label>模式</label>
        <div class="mode-toggle" id="modeToggle">
          <button type="button" class="mode-btn active" data-mode="collab">🤝 协作模式<span class="md">邀请好友一起确认完成</span></button>
          <button type="button" class="mode-btn" data-mode="solo">👤 单人模式<span class="md">自己设定目标自己完成</span></button>
        </div>
      </div>
      <button class="btn" type="submit">✨ 创建清单</button>
    </form>`;
}

function bindCreateForm() {
  const form = $('#createForm');
  if (!form) return;
  let mode = 'collab';
  form.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      form.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      mode = btn.dataset.mode;
    });
  });
  const targetInput = $('#targetCount', form);
  form.querySelectorAll('.target-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = parseInt(btn.dataset.d, 10);
      const cur = parseInt(targetInput.value, 10) || 1;
      targetInput.value = Math.max(1, Math.min(999, cur + d));
    });
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '创建中…';
    try {
      const name = $('#listName', form).value.trim();
      const creatorName = $('#creatorName', form).value.trim();
      const targetCount = parseInt(targetInput.value, 10) || 1;
      const r = createList({ name, creatorName, mode, targetCount });
      saveP(r.token, { id: r.participantId, name: creatorName });
      trackList(r.token, name || '我们的打卡清单', 'creator', r.mode);
      location.hash = `/l/${r.token}`;
    } catch (err) {
      toast(err.message || '创建失败');
      btn.disabled = false; btn.textContent = '✨ 创建清单';
    }
  });
}

function loadHistory() {
  const mine = getMyLists();
  const grid = $('#historyGrid');
  if (!grid) return;
  const cards = mine.map((meta) => ({ meta, state: getState(meta.token) }));
  if (!cards.length) {
    grid.innerHTML = `<div class="empty-state"><div class="big">📭</div><div class="t">还没有清单</div><div class="d">点击上方按钮创建第一个</div></div>`;
    return;
  }
  const rank = { '进行中': 0, '未开始': 1, '已完成': 2, '已结束': 3, '已失效': 4 };
  cards.sort((a, b) => {
    const sa = statusOf(a.state), sb = statusOf(b.state);
    if (sa !== sb) return (rank[sa] ?? 9) - (rank[sb] ?? 9);
    return (b.meta.lastSeenAt || 0) - (a.meta.lastSeenAt || 0);
  });
  grid.innerHTML = cards.map(({ meta, state }) => historyCardHtml(meta, state)).join('');
  grid.querySelectorAll('.hcard').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.hcard-del')) return;
      location.hash = `/l/${el.dataset.token}`;
    });
    el.querySelector('.hcard-del')?.addEventListener('click', (e) => {
      e.stopPropagation();
      untrackList(el.dataset.token);
      el.remove();
      const c = $('.count'); if (c) c.textContent = String(Math.max(0, parseInt(c.textContent) - 1));
      toast('已从主页移除记录');
    });
  });
}

function statusOf(state) {
  if (!state) return '已失效';
  if (state.list.status === 'ended') return '已结束';
  const total = state.items.length;
  const done = state.items.filter((i) => i.completed).length;
  if (total === 0) return '未开始';
  if (done === total) return '已完成';
  return '进行中';
}

function historyCardHtml(meta, state) {
  if (!state) {
    return `
      <div class="hcard expired" data-token="${meta.token}">
        <button class="hcard-del" title="移除">✕</button>
        <div class="hcard-top">
          <span class="mode-tag ${meta.mode === 'solo' ? 'solo' : 'collab'}">${meta.mode === 'solo' ? '👤 单人' : '🤝 协作'}</span>
          <span class="status-pill dead">已失效</span>
        </div>
        <div class="hcard-name">${escapeHtml(meta.name)}</div>
        <div class="hcard-meta">该清单已不存在 · ${fmtRelative(meta.lastSeenAt)}访问</div>
      </div>`;
  }
  const total = state.items.length;
  const done = state.items.filter((i) => i.completed).length;
  const target = state.list.targetCount || 0;
  const ended = state.list.status === 'ended';
  const pctVsTarget = target ? Math.min(100, Math.round((done / target) * 100)) : 0;
  const status = statusOf(state);
  const statusClass = status === '已结束' ? 'ended' : status === '已完成' ? 'done' : status === '进行中' ? 'doing' : status === '未开始' ? 'todo' : 'dead';
  const roleTag = meta.role === 'creator' ? '我创建的' : '我加入的';
  const reachedTarget = target && done >= target;
  return `
    <div class="hcard ${status === '已完成' ? 'is-done' : ''} ${ended ? 'is-ended' : ''}" data-token="${meta.token}">
      <button class="hcard-del" title="移除">✕</button>
      <div class="hcard-top">
        <span class="mode-tag ${state.list.mode === 'solo' ? 'solo' : 'collab'}">${state.list.mode === 'solo' ? '👤 单人' : '🤝 协作'}</span>
        <span class="status-pill ${statusClass}">${status}</span>
      </div>
      <div class="hcard-name">${escapeHtml(state.list.name)}</div>
      <div class="hcard-progress">
        <div class="progress"><span style="width:${pctVsTarget}%"></span></div>
        <div class="hcard-ptext">目标 ${target} 件 · 完成 ${done} 件 · ${pctVsTarget}%${reachedTarget ? ' 🎉' : ''}</div>
      </div>
      <div class="hcard-foot">
        <div class="hcard-people">
          ${state.participants.slice(0, 4).map((p) => `<span class="avatar sm" style="background:${p.color}" title="${escapeHtml(p.name)}">${escapeHtml(initials(p.name))}</span>`).join('')}
          ${state.participants.length > 4 ? `<span class="more">+${state.participants.length - 4}</span>` : ''}
        </div>
        <span class="hcard-role">${roleTag} · ${fmtRelative(meta.lastSeenAt)}</span>
      </div>
    </div>`;
}

// ---------- list view ----------
function openList(token) {
  currentToken = token;
  touchList(token);
  const state = getState(token);
  if (!state) {
    app.innerHTML = `<div class="landing"><h1 class="red">清单不存在</h1><p class="sub">这个链接可能已失效。</p><a href="#/" class="btn" style="margin-top:18px">← 返回主页</a></div>`;
    return;
  }
  let p = loadP(token);
  if (!p) {
    cachedState = state;
    return showJoinModal(token, state.list.name, state.list.mode);
  }
  currentParticipant = p;
  renderShell(token);
  refresh();
}

function showJoinModal(token, listName, mode) {
  app.innerHTML = `<div class="landing"><h1 class="red">加入「${escapeHtml(listName)}」</h1></div>`;
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal">
      <div class="ico">🎉</div>
      <h3>加入协作</h3>
      <p>你被邀请一起共建「<b>${escapeHtml(listName)}」</b><br>输入名字即可加入打卡。</p>
      <input id="joinName" type="text" maxlength="16" placeholder="你的名字" autofocus />
      <button class="btn green" id="joinBtn">加入清单</button>
    </div>`;
  document.body.appendChild(bg);
  const input = $('#joinName', bg); input.focus();
  const doJoin = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    const btn = $('#joinBtn', bg);
    btn.disabled = true; btn.textContent = '加入中…';
    const pId = joinList({ token, name });
    if (!pId) { toast('清单不存在'); btn.disabled = false; btn.textContent = '加入清单'; return; }
    saveP(token, { id: pId, name });
    currentParticipant = { id: pId, name };
    trackList(token, listName, 'member', mode);
    bg.remove();
    renderShell(token);
    refresh();
  };
  $('#joinBtn', bg).addEventListener('click', doJoin);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
}

function renderShell(token) {
  app.innerHTML = `
    <div class="list-wrap">
      <div class="topbar">
        <div class="left">
          <a href="#/" class="btn ghost sm">← 主页</a>
          <a href="#/album/${token}" class="btn red sm">📖 纪念册</a>
        </div>
        <div class="right-actions" id="rightActions">
          <button class="btn ghost sm" id="endBtn" style="display:none">🏁 提前结束</button>
          <button class="btn blue" id="shareBtn">🔗 邀请好友</button>
        </div>
      </div>
      <div class="card" id="card">
        <div class="list-title" id="title">加载中…</div>
        <div class="list-meta" id="meta"></div>
        <div class="progress"><span id="bar"></span></div>
        <div class="progress-text" id="ptext"></div>
        <div class="ended-banner" id="endedBanner" style="display:none"></div>
        <div class="people" id="people"></div>
        <form class="add-row" id="addForm">
          <input id="newItem" type="text" maxlength="80" placeholder="添加打卡任务，回车确认…" />
          <button type="submit" title="添加">＋</button>
        </form>
        <div class="items" id="items"></div>
      </div>
    </div>`;
  $('#shareBtn').addEventListener('click', shareLink);
  $('#addForm').addEventListener('submit', onAdd);
  $('#endBtn').addEventListener('click', confirmEnd);
}

function confirmEnd() {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  const done = cachedState ? cachedState.items.filter((i) => i.completed).length : 0;
  const target = cachedState ? cachedState.list.targetCount : 0;
  bg.innerHTML = `
    <div class="modal">
      <div class="ico">🏁</div>
      <h3>提前结束打卡？</h3>
      <p>结束后将无法再添加任务，清单转为「已结束」状态，纪念册定格此刻。<br><br>当前已完成 <b>${done}/${target || '?'}</b> 件事。</p>
      <div class="modal-actions">
        <button class="btn ghost" id="cancelEnd">再想想</button>
        <button class="btn red" id="doEnd">确认结束</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  $('#cancelEnd', bg).addEventListener('click', () => bg.remove());
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
  $('#doEnd', bg).addEventListener('click', () => {
    const ok = endList({ token: currentToken });
    if (!ok) { toast('无法结束（清单不存在或已结束）'); return; }
    bg.remove();
    toast('🏁 打卡已结束，去纪念册看看吧');
    refresh();
  });
}

function onAdd(e) {
  e.preventDefault();
  const input = $('#newItem');
  const content = input.value.trim();
  if (!content) return;
  const r = addItem({ token: currentToken, content, participantId: currentParticipant?.id });
  if (r === null) { toast('清单不存在'); input.value = content; return; }
  if (r && r.error === 'ended') { toast('打卡已结束，无法添加任务'); input.value = content; return; }
  input.value = '';
  refresh();
}

function shareLink() {
  const url = `${location.origin}${location.pathname}#/l/${currentToken}`;
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = url; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('✅ 链接已复制，发给好友吧！'); } catch { toast(url); }
    ta.remove();
  };
  if (navigator.share) navigator.share({ title: '一起打卡吧', text: `来一起完成「${cachedState?.list.name || '打卡清单'}」！`, url }).catch(fallback);
  else if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => toast('✅ 链接已复制，发给好友吧！')).catch(fallback);
  else fallback();
}

// 数据变更后直接重新渲染
function refresh() {
  if (!currentToken) return;
  cachedState = getState(currentToken);
  currentParticipant = loadP(currentToken);
  renderState();
}

function renderState() {
  if (!cachedState) return;
  const { list, participants, items } = cachedState;
  const isSolo = participants.length === 1;
  const ended = list.status === 'ended';
  const target = list.targetCount || 0;
  const total = items.length;
  const done = items.filter((i) => i.completed).length;

  $('#title').innerHTML = `<span class="stamp">★</span> ${escapeHtml(list.name)} <span class="mode-tag ${list.mode === 'solo' ? 'solo' : 'collab'}" style="vertical-align:middle;font-size:13px">${list.mode === 'solo' ? '👤 单人' : '🤝 协作'}</span>`;

  const pctVsTarget = target ? Math.min(100, Math.round((done / target) * 100)) : 0;
  $('#meta').innerHTML = `目标 <b>${target}</b> 件事 · 已完成 <b>${done}</b> 件 · 共 ${total} 个任务 · ${participants.length} 人${isSolo ? '（单人）' : '协作'}${ended ? ' · 已结束' : ''}`;
  $('#bar').style.width = pctVsTarget + '%';
  const reachedTarget = target && done >= target;
  if (ended) {
    $('#ptext').innerHTML = reachedTarget
      ? `🎉 达成目标！完成 <b>${done}/${target}</b> 件`
      : `🏁 提前结束 · 完成 <b>${done}/${target}</b> 件`;
  } else if (!total) {
    $('#ptext').innerHTML = `目标 <b>${target}</b> 件事 · 快添加第一个任务吧`;
  } else if (reachedTarget) {
    $('#ptext').innerHTML = `🎉 已达成目标 <b>${done}/${target}</b> 件 · 可继续添加或提前结束`;
  } else {
    $('#ptext').innerHTML = `进度 <b>${done}/${target}</b> 件 (${pctVsTarget}%) · 还差 <b>${target - done}</b> 件达成目标`;
  }

  const banner = $('#endedBanner');
  if (ended) {
    banner.style.display = '';
    banner.className = 'ended-banner';
    banner.innerHTML = `🏁 本清单已于 <b>${fmtDate(list.endedAt)} ${fmtTime(list.endedAt).replace('今天 ', '')}</b> 结束打卡 · 任务已锁定，可在纪念册回顾`;
  } else {
    banner.style.display = 'none';
  }

  const pMap = {}; participants.forEach((p) => (pMap[p.id] = p));
  $('#people').innerHTML = participants.map((p) =>
    `<span class="avatar" style="background:${p.color}" title="${escapeHtml(p.name)}">${escapeHtml(initials(p.name))}</span>`
  ).join('') + (currentParticipant ? `<span class="you-tag">你：${escapeHtml(currentParticipant.name)}</span>` : '');

  $('#shareBtn').style.display = (isSolo || ended) ? 'none' : '';
  $('#endBtn').style.display = ended ? 'none' : '';

  const addForm = $('#addForm');
  addForm.style.display = ended ? 'none' : '';

  const itemsEl = $('#items');
  if (!total) {
    itemsEl.innerHTML = `<div class="empty-state"><div class="big">📝</div><div class="t">${ended ? '清单为空且已结束' : '清单还是空的'}</div><div class="d">${ended ? '去纪念册回顾，或回主页创建新清单' : (isSolo ? '添加你的第一个目标吧' : '添加任务，邀请好友一起打卡吧')}</div></div>`;
    return;
  }
  itemsEl.innerHTML = items.map((i) => {
    const creator = pMap[i.createdBy];
    const confIds = Object.keys(i.confirmations || {});
    const allConfirmed = i.completed;
    const meConfirmed = currentParticipant && !!i.confirmations[currentParticipant.id];
    const needImage = !i.image;
    const confAvatars = participants.map((p) => {
      const ok = !!i.confirmations[p.id];
      return `<span class="who">
        <span class="avatar sm ${ok ? '' : 'dim'}" style="background:${p.color}" title="${escapeHtml(p.name)}${ok ? ' 已确认' : ' 待确认'}">${escapeHtml(initials(p.name))}</span>
        ${ok ? '<span class="tick">✓</span>' : ''}
      </span>`;
    }).join('');

    let statusText;
    if (allConfirmed) statusText = `<b>${isSolo ? '打卡完成！' : '双方已确认，打卡完成！'}</b>`;
    else if (needImage) statusText = isSolo ? '需上传纪念照' : `已确认 ${confIds.length}/${participants.length} · 需上传纪念照`;
    else statusText = isSolo ? '上传照片后即可确认完成' : `已确认 ${confIds.length}/${participants.length} · 等待双方确认`;

    const confirmLabel = meConfirmed
      ? (isSolo ? '↩ 取消完成' : '↩ 取消确认')
      : (isSolo ? '✓ 完成打卡' : '✓ 我确认完成');

    const lockAttr = ended ? 'disabled' : '';
    const lockCls = ended ? ' locked' : '';

    return `
      <div class="item ${i.completed ? 'done' : ''}${lockCls}" data-id="${i.id}">
        <div class="item-top">
          <span class="handle" title="拖动排序">⠿</span>
          <div class="item-body">
            <div class="item-content">${escapeHtml(i.content)}</div>
            <div class="item-info">
              ${creator ? `<span class="avatar sm" style="background:${creator.color}">${escapeHtml(initials(creator.name))}</span>${escapeHtml(creator.name)} 添加` : ''}
              ${i.completedAt ? `· 完成于 ${fmtTime(i.completedAt)}` : ''}
            </div>
          </div>
          ${allConfirmed ? '<span class="stamp-done">✓ DONE</span>' : ''}
          <button class="item-del" data-act="del" title="${ended ? '已结束' : '删除'}" ${lockAttr}>✕</button>
        </div>

        <div class="memento ${i.image ? 'has-img' : ''}" data-act="img">
          ${i.image
            ? `<img src="${i.image}" alt="纪念照" /><div class="cap"><span>📷 纪念照</span><span>${ended ? '' : '点击更换'}</span></div>`
            : `<div class="empty"><div class="ico">📷</div><div class="t">${ended ? '未上传纪念照' : '上传纪念照'}</div><div class="d">${ended ? '' : (isSolo ? '记录你的打卡瞬间' : '完成后留存回忆（确认前必传）')}</div></div>`}
        </div>

        <div class="confirm-row">
          <div class="confirm-avatars">${confAvatars}</div>
          <div class="confirm-status">${statusText}</div>
          <button class="btn sm ${meConfirmed ? 'ghost' : 'green'}" data-act="confirm" ${(needImage || ended) ? 'disabled' : ''} title="${ended ? '已结束' : (needImage ? '请先上传纪念照' : '')}">
            ${confirmLabel}
          </button>
        </div>
      </div>`;
  }).join('');

  bindItemEvents(itemsEl, items, ended);
}

function bindItemEvents(itemsEl, items, ended) {
  itemsEl.querySelectorAll('.item').forEach((el) => {
    const id = el.dataset.id;
    const delBtn = el.querySelector('[data-act="del"]');
    if (!ended && delBtn) delBtn.addEventListener('click', () => {
      const ok = deleteItem({ token: currentToken, itemId: id });
      if (!ok) { toast('删除失败'); return; }
      refresh();
    });
    const imgEl = el.querySelector('[data-act="img"]');
    if (!ended && imgEl) imgEl.addEventListener('click', () => pickImage(id));
    const confirmBtn = el.querySelector('[data-act="confirm"]');
    if (!ended && confirmBtn) confirmBtn.addEventListener('click', () => {
      const r = toggleConfirm({ token: currentToken, itemId: id, participantId: currentParticipant?.id });
      if (r === null) { toast('操作失败'); return; }
      if (r.error === 'need_image') { toast('请先上传纪念照'); return; }
      refresh();
    });

    if (ended) return;
    // 拖拽排序
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      dragId = id;
      e.dataTransfer.effectAllowed = 'move';
      el.style.opacity = '.5';
    });
    el.addEventListener('dragend', () => { el.style.opacity = ''; });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (dragId && dragId !== id) el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      if (!dragId || dragId === id) return;
      const ids = items.map((i) => i.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(id);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      ids.splice(to, 0, dragId);
      reorderItems({ token: currentToken, orderedIds: ids });
      dragId = null;
      refresh();
    });
  });
}

function pickImage(itemId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    toast('📷 上传中…');
    try {
      const dataUrl = await resizeImage(file);
      const ok = setItemImage({ token: currentToken, itemId, image: dataUrl });
      if (!ok) { toast('上传失败'); return; }
      toast('✅ 纪念照已上传');
      refresh();
    } catch (e) { toast(e.message || '上传失败'); }
  });
  input.click();
}

// ---------- album view ----------
function openAlbum(token) {
  currentToken = token;
  touchList(token);
  currentParticipant = loadP(token);
  const state = getState(token);
  if (!state) {
    app.innerHTML = `<div class="landing"><h1 class="red">清单不存在</h1><a href="#/" class="btn" style="margin-top:18px">← 返回主页</a></div>`;
    return;
  }
  cachedState = state;
  renderAlbum(token, state);
}

function renderAlbum(token, state) {
  const { list, participants, items } = state;
  const pMap = {}; participants.forEach((p) => (pMap[p.id] = p));
  const done = items.filter((i) => i.completed).length;
  const total = items.length;
  const target = list.targetCount || 0;
  const pct = target ? Math.min(100, Math.round((done / target) * 100)) : 0;
  const ended = list.status === 'ended';
  const reachedTarget = target && done >= target;

  const statusLine = ended
    ? (reachedTarget ? `🏁 已结束 · 达成目标` : `🏁 提前结束 · 完成 ${done}/${target}`)
    : (reachedTarget ? `🎉 已达成目标` : `完成 ${done}/${target}`);

  // 按完成顺序排列：有 completedAt 的按时间升序，未完成的排最后（按添加顺序）
  const ordered = [...items].sort((a, b) => {
    if (a.completed && b.completed) return a.completedAt - b.completedAt;
    if (a.completed) return -1;
    if (b.completed) return 1;
    return a.createdAt - b.createdAt;
  });

  const cards = ordered.map((i, idx) => {
    const makers = Object.keys(i.confirmations || {}).map((pid) => pMap[pid]).filter(Boolean);
    return `
      <div class="polaroid ${i.completed ? '' : 'pending'}">
        <div class="num">${idx + 1}</div>
        ${i.completed ? '<span class="stamp-done">✓ DONE</span>' : '<span class="stamp-pending">待完成</span>'}
        <div class="ph">
          ${i.image ? `<img src="${i.image}" alt="${escapeHtml(i.content)}" />` : `<div class="placeholder">${i.completed ? '📷' : '⏳'}</div>`}
        </div>
        <div class="cap">${escapeHtml(i.content)}</div>
        ${i.completedAt
          ? `<div class="date">📅 ${fmtDate(i.completedAt)}</div>`
          : '<div class="date pending-date">未完成</div>'}
        ${makers.length ? `<div class="makers">${makers.map((m) => `<span class="avatar sm" style="background:${m.color}" title="${escapeHtml(m.name)}">${escapeHtml(initials(m.name))}</span>`).join('')}</div>` : ''}
      </div>`;
  }).join('');

  app.innerHTML = `
    <div class="album">
      <div class="album-head">
        <h1>${escapeHtml(list.name)}</h1>
        <div class="sub">打卡纪念册 · 按完成顺序</div>
        <div class="meta">${statusLine} · ${pct}% · ${participants.length} 人协作</div>
      </div>
      <div class="album-actions">
        <a href="#/l/${token}" class="btn ghost">← 返回清单</a>
        <button class="btn blue" id="printBtn">🖨 打印 / 保存PDF</button>
        <button class="btn" id="shareAlbum">🔗 分享纪念册</button>
      </div>
      ${total
        ? `<div class="scrapbook">${cards}</div>
           <div class="album-footer">— 共同的回忆，永远的珍藏 <span class="heart">♥</span> —</div>`
        : `<div class="album-empty"><div style="font-size:60px">📖</div><p style="margin-top:10px;font-size:20px">${ended ? '本清单已结束，暂无打卡任务' : '还没有打卡任务，去清单里添加吧'}</p><a href="#/l/${token}" class="btn" style="margin-top:18px">前往清单</a></div>`}
    </div>`;
  $('#printBtn')?.addEventListener('click', () => window.print());
  $('#shareAlbum')?.addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}#/album/${token}`;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => toast('✅ 纪念册链接已复制！')).catch(() => toast(url));
    else toast(url);
  });
}

route();
