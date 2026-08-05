#!/bin/bash
set -e

REPO="${GITHUB_REPOSITORY:-12siii/silver}"
GH_API="https://api.github.com/repos/${REPO}/contents"
AUTH_HEADER="Authorization: token ${GITHUB_TOKEN}"

# Helper: 从 GitHub API 响应中提取 JSON 字段
gh_get() {
  curl -s -H "$AUTH_HEADER" -H "Accept: application/vnd.github.v3+json" "$GH_API/$1" 2>/dev/null
}
gh_field() {
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('$1',''))" 2>/dev/null || true
}

# 同步前端文件到 public/（后端也提供前端页面）
echo "=== 同步前端文件 ==="
cp index.html app.js style.css backend-url.json public/ 2>/dev/null || true

# 安装依赖
echo "=== 安装依赖 ==="
npm install

# ============================================================
# 数据持久化：从 GitHub 仓库恢复 data.json
# ============================================================
echo "=== 恢复数据 ==="
DATA_RESP=$(gh_get data.json)
DATA_SHA=$(echo "$DATA_RESP" | gh_field sha)
if [ -n "$DATA_SHA" ]; then
  echo "$DATA_RESP" | python3 -c "import json,sys,base64; d=json.load(sys.stdin); sys.stdout.buffer.write(base64.b64decode(d['content']))" > data.json 2>/dev/null || true
  echo "✅ 已从仓库恢复数据"
else
  echo "ℹ️ 仓库中暂无数据文件，从零开始"
fi

# 启动打卡服务
echo "=== 启动服务器 ==="
nohup node server.js > /tmp/server.log 2>&1 &
sleep 8

echo "=== 检查服务器状态 ==="
for i in 1 2 3 4 5; do
  CODE=$(curl -sS -o /dev/null -w "%{http_code}" http://localhost:3000/ || echo "000")
  if [ "$CODE" = "200" ]; then
    echo "✅ 服务器启动成功 (HTTP $CODE)"
    break
  fi
  echo "等待服务器... ($CODE)"
  sleep 3
done

cat /tmp/server.log | head -15 || true

# 下载 cloudflared
echo ""
echo "=== 下载 Cloudflare Tunnel ==="
wget -q "https://github.com/cloudflare/cloudflared/releases/download/2024.11.0/cloudflared-linux-amd64" -O /tmp/cf
chmod +x /tmp/cf
/tmp/cf --version 2>/dev/null || echo "Cloudflare ready"

# 启动隧道
echo ""
echo "=== 启动公网隧道 (请稍候，正在获取 URL) ==="
/tmp/cf tunnel --url http://localhost:3000 --no-autoupdate --logfile /tmp/cf.log > /dev/null 2>&1 &

# 等待获取公网 URL
URL=""
for n in $(seq 1 25); do
  sleep 4
  URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /tmp/cf.log 2>/dev/null | head -1 || true)
  if [ -n "$URL" ]; then
    break
  fi
  echo "... ($n/25) 正在获取公网地址..."
done

if [ -z "$URL" ]; then
  echo ""
  echo "❌ 获取公网 URL 失败"
  echo "Cloudflare 日志:"
  cat /tmp/cf.log || true
  exit 1
fi

echo ""
echo "================================================================"
echo "  🎉 部署成功！"
echo "  🌐 后端地址: $URL"
echo "  🔗 永久入口: https://12siii.github.io/silver/"
echo "================================================================"

# 写入 GitHub Job Summary
{
  echo "## 🌐 部署成功"
  echo ""
  echo "### 永久入口"
  echo "https://12siii.github.io/silver/"
  echo ""
  echo "### 后端隧道"
  echo "$URL"
  echo ""
  echo "系统每 30 分钟自动刷新隧道，数据实时持久化，随时可用。"
} >> "$GITHUB_STEP_SUMMARY"

# ============================================================
# 更新 backend-url.json（前端通过此文件获取后端地址）
# ============================================================
echo ""
echo "=== 更新 backend-url.json ==="

JSON_CONTENT=$(echo -n "{\"url\":\"${URL}\",\"ts\":$(date +%s)}" | base64 -w0)

# 获取当前 backend-url.json 的 sha
BURL_SHA=$(gh_get backend-url.json | gh_field sha)

if [ -n "$BURL_SHA" ]; then
  BODY="{\"message\":\"auto: update backend URL\",\"content\":\"${JSON_CONTENT}\",\"sha\":\"${BURL_SHA}\"}"
else
  BODY="{\"message\":\"auto: create backend URL config\",\"content\":\"${JSON_CONTENT}\"}"
fi

RESPONSE=$(curl -s -X PUT \
  -H "$AUTH_HEADER" \
  -H "Accept: application/vnd.github.v3+json" \
  "$GH_API/backend-url.json" \
  -d "$BODY" 2>&1)

if echo "$RESPONSE" | grep -q '"content"'; then
  echo "✅ backend-url.json 已更新！"
else
  echo "⚠️ backend-url.json 更新失败"
  echo "$RESPONSE" | head -5
fi

# ============================================================
# 数据持久化：定期将 data.json 提交到仓库（每 20 秒）
# ============================================================
echo ""
echo "=== 启动数据持久化守护 ==="
(
  LAST_HASH=""
  while true; do
    sleep 20
    [ ! -f data.json ] && continue
    # 检查文件是否有变化
    CUR_HASH=$(md5sum data.json | cut -d' ' -f1)
    [ "$CUR_HASH" = "$LAST_HASH" ] && continue
    LAST_HASH="$CUR_HASH"

    # 获取当前 data.json 的 sha
    DSHA=$(gh_get data.json | gh_field sha)
    DCONTENT=$(base64 -w0 < data.json)
    if [ -n "$DSHA" ]; then
      DBODY="{\"message\":\"auto: sync data\",\"content\":\"${DCONTENT}\",\"sha\":\"${DSHA}\"}"
    else
      DBODY="{\"message\":\"auto: initial data\",\"content\":\"${DCONTENT}\"}"
    fi
    curl -s -X PUT -H "$AUTH_HEADER" -H "Accept: application/vnd.github.v3+json" "$GH_API/data.json" -d "$DBODY" > /dev/null 2>&1 || true
    echo "[$(date '+%H:%M:%S')] 数据已同步"
  done
) &
SYNC_PID=$!

# 保持进程存活，维持隧道开放（35 分钟，与下次定时任务重叠确保无缝衔接）
echo ""
echo "服务器与隧道运行中...保持连接中"
END_TIME=$((SECONDS + 2100)) # 35 分钟
while [ $SECONDS -lt $END_TIME ]; do
  sleep 60
  # 检查服务器是否还活着
  if ! kill -0 %1 2>/dev/null; then
    echo "⚠️ 服务器进程已退出"
    break
  fi
  echo "[$(date '+%H:%M:%S')] 运行中... 剩余 $(( (END_TIME - SECONDS) / 60 )) 分钟"
done

echo "=== 本次运行结束，清理进程 ==="
kill $SYNC_PID 2>/dev/null || true
