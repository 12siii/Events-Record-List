const app = document.getElementById('app');
let BACKEND_URL = ''; // 动态后端地址，从 backend-url.json 加载
let ws = null;
let currentToken = null;
let currentParticipant = null;
let cachedState = null;
let dragId = null;

// ---------- 加载后端地址 ----------
async function initBackend() {
  // 尝试从 backend-url.json 获取后端地址（GitHub Pages 部署时）
  // 如果获取失败，说明前后端同源（本地开发），使用相对路径
  try {
    const res = await fetch('backend-url.json?t=' + Date.now());
    if (res.ok) {
      const data = await res.json();
      if (data.url) {
        BACKEND_URL = data.url.replace(/\/$/, ''); // 去掉末尾斜杠
        console.log('后端地址:', BACKEND_URL);
        return true;
      }
      return false; // 文件存在但 URL 为空（后端尚未启动）
    }
  } catch (e) {
    console.log('使用同源后端（本地开发模式）');
    return true; // 本地开发模式，使用相对路径
  }
  return false;
}

// 显示加载状态
function showLoading(msg = '正在连接服务器…') {
  app.innerHTML = `
    <div class="landing">
      <h1>一起<span class="red">打卡</span>吧</h1>
      <div style="margin-top:30px;font-size:20px;color:var(--muted);">${msg}</div>
      <div style="margin-top:20px;width:50px;height:50px;border:4px solid var(--paper2);border-top:4px solid var(--red);border-radius:50%;animation:spin 1s linear infinite;margin-left:auto;margin-right:auto;"></div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    </div>`;
}

// 等待后端就绪（重试机制）
async function waitForBackend() {
  for (let i = 0; i < 720; i++) { // 最多等 2 小时（每 10 秒重试一次）
    const ok = await initBackend();
    if (ok) return;
    showLoading('服务器正在启动中，请稍候…（自动重试）');
    await new Promise(r => setTimeout(r, 10000));
  }
}

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const initials = (name) => (name || '?').trim().slice(0, 1).toUpperCase();
const pKey = (token) => `daka:p:${token}`;
const loadP = (token) => { try { return JSON.parse(localStorage.getItem(pKey(token)) || 'null'); } catch { return null; } };
const saveP = (token, p) => localStorage.setItem(pKey(token), JSON.stringify(p));

// 我的历史清单（本机记录）
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

const toast = (msg) => {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
};

async function api(path, opts = {}) {
  const url = BACKEND_URL + path;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || '请求失败');
  }
  return res.json();
}

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
async function renderHome() {
  closeWs();
  currentToken = null;
  const mine = getMyLists();
  const hasHistory = mine.length > 0;

  app.innerHTML = `
    <div class="home">
      <div class="home-head">
        <div class="badge"><span class="dot"></span> 我的打卡台</div>
        <h1>一起<span class="red">打卡</span>吧</h1>
        <p class="sub">设定目标，共同完成，留下回忆。<b>单人</b>自己打卡，<b>协作</b>邀请好友一起确认。</p>
        <button class="btn blue" id="newBtn">＋ 创建新清单</button>
      </div>

      <div class="create-section" id="createSection" style="${hasHistory ? 'display:none' : ''}">
        ${createFormHtml()}
      </div>

      <div class="history-section" id="historySection" style="${hasHistory ? '' : 'display:none'}">
        <h2 class="section-title">我的清单 <span class="count">${mine.length}</span></h2>
        <div id="historyGrid" class="history-grid"><div class="loading">加载中…</div></div>
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

  if (hasHistory) await loadHistory();
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
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '创建中…';
    try {
      const name = $('#listName', form).value.trim();
      const creatorName = $('#creatorName', form).value.trim();
      const targetCount = parseInt(targetInput.value, 10) || 1;
      const r = await api('/api/lists', { method: 'POST', body: { name, creatorName, mode, targetCount } });
      saveP(r.token, { id: r.participantId, name: creatorName });
      trackList(r.token, name, 'creator', r.mode);
      location.hash = `/l/${r.token}`;
    } catch (err) {
      toast(err.message);
      btn.disabled = false; btn.textContent = '✨ 创建清单';
    }
  });
}

async function loadHistory() {
  const mine = getMyLists();
  const grid = $('#historyGrid');
  if (!grid) return;
  const results = await Promise.allSettled(
    mine.map((m) => api(`/api/lists/${m.token}`).then((s) => ({ meta: m, state: s })).catch(() => ({ meta: m, state: null })))
  );
  const cards = results.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
  if (!cards.length) {
    grid.innerHTML = `<div class="empty-state"><div class="big">📭</div><div class="t">还没有清单</div><div class="d">点击上方按钮创建第一个</div></div>`;
    return;
  }
  // 排序：进行中优先，再按最近访问
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
async function openList(token) {
  currentToken = token;
  touchList(token);
  let p = loadP(token);
  try {
    if (!p) {
      cachedState = await api(`/api/lists/${token}`);
      return showJoinModal(token, cachedState.list.name, cachedState.list.mode);
    }
    currentParticipant = p;
    renderShell(token);
    await refresh();
    connectWs(token);
  } catch (e) {
    app.innerHTML = `<div class="landing"><h1 class="red">清单不存在</h1><p class="sub">这个链接可能已失效。</p><a href="#/" class="btn" style="margin-top:18px">← 返回主页</a></div>`;
  }
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
  const doJoin = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    const btn = $('#joinBtn', bg);
    btn.disabled = true; btn.textContent = '加入中…';
    try {
      const r = await api(`/api/lists/${token}/join`, { method: 'POST', body: { name } });
      saveP(token, { id: r.participantId, name });
      currentParticipant = { id: r.participantId, name };
      trackList(token, listName, 'member', mode);
      bg.remove();
      renderShell(token);
      await refresh();
      connectWs(token);
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = '加入清单'; }
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
    </div>
    <div class="conn" id="conn"><span class="d"></span> 已连接</div>`;
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
  $('#doEnd', bg).addEventListener('click', async () => {
    const btn = $('#doEnd', bg);
    btn.disabled = true;
    try {
      await api(`/api/lists/${currentToken}/end`, { method: 'PATCH' });
      bg.remove();
      toast('🏁 打卡已结束，去纪念册看看吧');
    } catch (e) { toast(e.message); btn.disabled = false; }
  });
}

function onAdd(e) {
  e.preventDefault();
  const input = $('#newItem');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  api(`/api/lists/${currentToken}/items`, {
    method: 'POST', body: { content, participantId: currentParticipant?.id }
  }).catch((err) => { toast(err.message); input.value = content; });
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

async function refresh() {
  if (!currentToken) return;
  try {
    cachedState = await api(`/api/lists/${currentToken}`);
    currentParticipant = loadP(currentToken);
    renderState();
  } catch (e) { toast(e.message); }
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

  // 进度按目标计算
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

  // 结束横幅
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

  // 按钮：单人隐藏邀请；已结束隐藏结束按钮
  $('#shareBtn').style.display = (isSolo || ended) ? 'none' : '';
  $('#endBtn').style.display = ended ? 'none' : '';

  // 已结束锁定添加
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

    // 已结束：操作按钮禁用
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
      api(`/api/lists/${currentToken}/items/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
    });
    const imgEl = el.querySelector('[data-act="img"]');
    if (!ended && imgEl) imgEl.addEventListener('click', () => pickImage(id));
    const confirmBtn = el.querySelector('[data-act="confirm"]');
    if (!ended && confirmBtn) confirmBtn.addEventListener('click', () => {
      api(`/api/lists/${currentToken}/items/${id}/confirm`, {
        method: 'PATCH', body: { participantId: currentParticipant?.id }
      }).catch((e) => toast(e.message));
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
      api(`/api/lists/${currentToken}/order`, { method: 'PUT', body: { orderedIds: ids } }).catch((e) => toast(e.message));
      dragId = null;
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
      await api(`/api/lists/${currentToken}/items/${itemId}/image`, {
        method: 'POST', body: { image: dataUrl }
      });
      toast('✅ 纪念照已上传');
    } catch (e) { toast(e.message || '上传失败'); }
  });
  input.click();
}

// ---------- album view ----------
async function openAlbum(token) {
  currentToken = token;
  touchList(token);
  closeWs();
  currentParticipant = loadP(token);
  app.innerHTML = `<div class="album"><div class="album-empty">加载纪念册…</div></div>`;
  try {
    const state = await api(`/api/lists/${token}`);
    cachedState = state;
    renderAlbum(token, state);
  } catch (e) {
    app.innerHTML = `<div class="landing"><h1 class="red">清单不存在</h1><a href="#/" class="btn" style="margin-top:18px">← 返回主页</a></div>`;
  }
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

// ---------- websocket ----------
function connectWs(token) {
  closeWs();
  // 根据后端地址构建 WebSocket URL
  let wsUrl;
  if (BACKEND_URL) {
    // 将 http(s):// 转为 ws(s)://
    wsUrl = BACKEND_URL.replace(/^http/, 'ws');
  } else {
    // 本地开发模式：使用当前页面协议和主机
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    wsUrl = `${proto}://${location.host}`;
  }
  ws = new WebSocket(`${wsUrl}/?token=${token}`);
  const setConn = (ok) => {
    const el = $('#conn');
    if (!el) return;
    el.classList.toggle('off', !ok);
    el.innerHTML = `<span class="d"></span> ${ok ? '已连接' : '正在重连…'}`;
  };
  ws.onopen = () => setConn(true);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') { cachedState = msg.state; renderState(); }
    } catch {}
  };
  ws.onclose = () => { setConn(false); if (currentToken === token) setTimeout(() => connectWs(token), 1500); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function closeWs() {
  if (!ws) return;
  const old = ws; ws = null;
  old.onclose = null;
  try { old.close(); } catch {}
}

// 启动应用：先加载后端地址，再路由
(async () => {
  showLoading();
  await waitForBackend();
  route();
})();
