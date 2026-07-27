import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  load, createList, getState, joinList, addItem, setItemImage,
  toggleConfirm, reorderItems, deleteItem, endList
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

load();

const app = express();
app.use(express.json({ limit: '15mb' })); // 兼容 base64 图片
app.use(express.static(join(__dirname, 'public')));

app.post('/api/lists', (req, res) => {
  const { name, creatorName, mode, targetCount } = req.body || {};
  res.json(createList({ name, creatorName, mode, targetCount }));
});

app.get('/api/lists/:token', (req, res) => {
  const state = getState(req.params.token);
  if (!state) return res.status(404).json({ error: '清单不存在' });
  res.json(state);
});

app.post('/api/lists/:token/join', (req, res) => {
  const { name } = req.body || {};
  const pId = joinList({ token: req.params.token, name });
  if (!pId) return res.status(404).json({ error: '清单不存在' });
  res.json({ participantId: pId });
});

app.post('/api/lists/:token/items', (req, res) => {
  const { content, participantId } = req.body || {};
  const r = addItem({ token: req.params.token, content, participantId });
  if (r === null) return res.status(404).json({ error: '清单不存在' });
  if (r && r.error === 'ended') return res.status(400).json({ error: '打卡已结束，无法添加任务' });
  broadcast(req.params.token);
  res.json({ id: r });
});

// 提前结束打卡
app.patch('/api/lists/:token/end', (req, res) => {
  const ok = endList({ token: req.params.token });
  if (!ok) return res.status(400).json({ error: '无法结束（清单不存在或已结束）' });
  broadcast(req.params.token);
  res.json({ ok: true });
});

// 上传纪念照
app.post('/api/lists/:token/items/:itemId/image', (req, res) => {
  const { image } = req.body || {};
  const ok = setItemImage({ token: req.params.token, itemId: req.params.itemId, image });
  if (!ok) return res.status(404).json({ error: '操作失败' });
  broadcast(req.params.token);
  res.json({ ok: true });
});

// 确认 / 取消确认
app.patch('/api/lists/:token/items/:itemId/confirm', (req, res) => {
  const { participantId } = req.body || {};
  const r = toggleConfirm({ token: req.params.token, itemId: req.params.itemId, participantId });
  if (r === null) return res.status(404).json({ error: '操作失败' });
  if (r && r.error) return res.status(400).json({ error: r.error });
  broadcast(req.params.token);
  res.json({ ok: true });
});

// 排序
app.put('/api/lists/:token/order', (req, res) => {
  const { orderedIds } = req.body || {};
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: '参数错误' });
  reorderItems({ token: req.params.token, orderedIds });
  broadcast(req.params.token);
  res.json({ ok: true });
});

app.delete('/api/lists/:token/items/:itemId', (req, res) => {
  const ok = deleteItem({ token: req.params.token, itemId: req.params.itemId });
  if (!ok) return res.status(404).json({ error: '删除失败' });
  broadcast(req.params.token);
  res.json({ ok: true });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

const server = createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();

function broadcast(token) {
  const state = getState(token);
  const msg = JSON.stringify({ type: 'state', state });
  const room = rooms.get(token);
  if (room) for (const ws of room) if (ws.readyState === 1) ws.send(msg);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  if (!token) { ws.close(); return; }
  if (!rooms.has(token)) rooms.set(token, new Set());
  rooms.get(token).add(ws);
  const state = getState(token);
  if (state) ws.send(JSON.stringify({ type: 'state', state }));
  ws.on('close', () => {
    const room = rooms.get(token);
    if (room) { room.delete(ws); if (room.size === 0) rooms.delete(token); }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 打卡清单服务已启动: http://localhost:${PORT}`);
});
