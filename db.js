import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const DB_FILE = new URL('./data.json', import.meta.url).pathname;
const COLORS = ['#e63946', '#2563eb', '#f59e0b', '#16a34a', '#7c3aed', '#db2777', '#0891b2', '#ea580c', '#0d9488', '#4338ca'];

let data = { lists: {}, participants: {}, items: {} };

export function load() {
  try {
    if (existsSync(DB_FILE)) {
      data = JSON.parse(readFileSync(DB_FILE, 'utf8'));
      if (!data.lists) data = { lists: {}, participants: {}, items: {} };
      // 归一化旧数据 / 补字段
      let idx = 0;
      for (const id in data.items) {
        const it = data.items[id];
        if (!it.confirmations) it.confirmations = {};
        if (it.image === undefined) it.image = null;
        if (it.order === undefined) it.order = idx;
        idx++;
      }
      for (const id in data.lists) {
        if (!data.lists[id].mode) data.lists[id].mode = 'collab';
        if (data.lists[id].targetCount === undefined) data.lists[id].targetCount = 0;
        if (!data.lists[id].status) data.lists[id].status = 'active';
        if (data.lists[id].endedAt === undefined) data.lists[id].endedAt = null;
      }
    }
  } catch (e) {
    console.error('DB load failed:', e.message);
    data = { lists: {}, participants: {}, items: {} };
  }
}

function save() {
  try {
    mkdirSync(dirname(DB_FILE), { recursive: true });
    writeFileSync(DB_FILE, JSON.stringify(data));
  } catch (e) {
    console.error('DB save failed:', e.message);
  }
}

const colorFor = (i) => COLORS[i % COLORS.length];

export function createList({ name, creatorName, mode, targetCount }) {
  const id = randomUUID();
  const token = randomUUID().replace(/-/g, '').slice(0, 12);
  const now = Date.now();
  const tc = Math.max(1, Math.min(999, parseInt(targetCount, 10) || 1));
  data.lists[id] = {
    id, name: (name || '').trim() || '我们的打卡清单',
    token, mode: mode === 'solo' ? 'solo' : 'collab',
    targetCount: tc, status: 'active', endedAt: null,
    createdAt: now
  };
  const pId = randomUUID();
  data.participants[pId] = { id: pId, listId: id, name: (creatorName || '').trim() || '发起人', color: colorFor(0), joinedAt: now };
  save();
  return { listId: id, token, participantId: pId, mode: data.lists[id].mode, targetCount: tc };
}

export const getListByToken = (token) => Object.values(data.lists).find((l) => l.token === token) || null;

export function getState(token) {
  const list = getListByToken(token);
  if (!list) return null;
  const participants = Object.values(data.participants)
    .filter((p) => p.listId === list.id)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const pIds = new Set(participants.map((p) => p.id));
  const items = Object.values(data.items)
    .filter((i) => i.listId === list.id)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // 派生完成态：所有当前参与者都确认才算完成
  const itemsView = items.map((i) => {
    const confirmations = {};
    for (const k in (i.confirmations || {})) if (pIds.has(k)) confirmations[k] = i.confirmations[k];
    const confirmedCount = Object.keys(confirmations).length;
    const completed = participants.length > 0 && confirmedCount === participants.length;
    const completedAt = completed ? Math.max(...Object.values(confirmations)) : null;
    return {
      id: i.id, content: i.content, createdBy: i.createdBy, createdAt: i.createdAt,
      order: i.order ?? 0, image: i.image || null, confirmations, completed, completedAt
    };
  });
  return { list, participants, items: itemsView };
}

export function joinList({ token, name }) {
  const list = getListByToken(token);
  if (!list) return null;
  const n = (name || '').trim() || '好友';
  const existing = Object.values(data.participants).find((p) => p.listId === list.id && p.name === n);
  if (existing) return existing.id;
  const count = Object.values(data.participants).filter((p) => p.listId === list.id).length;
  const pId = randomUUID();
  data.participants[pId] = { id: pId, listId: list.id, name: n, color: colorFor(count), joinedAt: Date.now() };
  save();
  return pId;
}

export function addItem({ token, content, participantId }) {
  const list = getListByToken(token);
  if (!list) return null;
  if (list.status === 'ended') return { error: 'ended' };
  const count = Object.values(data.items).filter((i) => i.listId === list.id).length;
  const id = randomUUID();
  data.items[id] = {
    id, listId: list.id, content: (content || '').trim(),
    createdBy: participantId || null, createdAt: Date.now(),
    order: count, image: null, confirmations: {}
  };
  save();
  return id;
}

export function endList({ token }) {
  const list = getListByToken(token);
  if (!list) return false;
  if (list.status === 'ended') return false;
  list.status = 'ended';
  list.endedAt = Date.now();
  save();
  return true;
}

export function setItemImage({ token, itemId, image }) {
  const list = getListByToken(token);
  if (!list) return false;
  const it = data.items[itemId];
  if (!it || it.listId !== list.id) return false;
  it.image = image || null;
  save();
  return true;
}

// 确认 / 取消确认；确认前必须有纪念照
export function toggleConfirm({ token, itemId, participantId }) {
  const list = getListByToken(token);
  if (!list) return null;
  const it = data.items[itemId];
  if (!it || it.listId !== list.id) return null;
  if (!it.confirmations) it.confirmations = {};
  if (!it.confirmations[participantId] && !it.image) return { error: 'need_image' };
  if (it.confirmations[participantId]) delete it.confirmations[participantId];
  else it.confirmations[participantId] = Date.now();
  save();
  return { ok: true };
}

export function reorderItems({ token, orderedIds }) {
  const list = getListByToken(token);
  if (!list) return false;
  orderedIds.forEach((id, idx) => {
    const it = data.items[id];
    if (it && it.listId === list.id) it.order = idx;
  });
  save();
  return true;
}

export function deleteItem({ token, itemId }) {
  const list = getListByToken(token);
  if (!list) return false;
  const it = data.items[itemId];
  if (!it || it.listId !== list.id) return false;
  delete data.items[itemId];
  save();
  return true;
}
