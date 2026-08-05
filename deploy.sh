#!/bin/bash
set -e

# 安装依赖
echo "=== 安装依赖 ==="
npm install

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
echo "  🎉🎉🎉  部署成功！"
echo ""
echo "  🌐 公网访问地址:"
echo "     $URL"
echo ""
echo "  💡 使用说明:"
echo "     • 复制上面的链接分享给好友，一起共建打卡清单"
echo "     • 支持多人协作打卡、拖拽排序、上传图片纪念"
echo "     • 此链接最长有效期约 5.5 小时"
echo "     • 系统每 4 小时自动刷新链接，GitHub Pages 跳转页自动更新"
echo "     • 永久入口: https://12siii.github.io/silver/"
echo "================================================================"
echo ""

# 写入 GitHub Job Summary
{
  echo "## 🌐 公网访问地址"
  echo ""
  echo "### ✅ [$URL]($URL)"
  echo ""
  echo "复制上方链接分享给好友，即可一起共建打卡清单 🎯"
  echo ""
  echo "### ⏰ 自动刷新"
  echo "系统每 4 小时自动运行，GitHub Pages 跳转页自动更新。"
  echo "永久入口: https://12siii.github.io/silver/"
} >> "$GITHUB_STEP_SUMMARY"

# ============================================================
# 自动更新 GitHub Pages 跳转页面（永久固定 URL）
# ============================================================
echo ""
echo "=== 更新 GitHub Pages 跳转页面 ==="

# 生成跳转 HTML
cat > /tmp/redirect.html << REDIRECT_EOF
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>一起打卡吧 · 协作打卡清单</title>
<meta http-equiv="refresh" content="2; url=${URL}">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>✅</text></svg>">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;background:#f5f0e8;color:#333;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{text-align:center;padding:40px;background:#fff;border:3px solid #333;border-radius:20px;box-shadow:6px 6px 0 #333;max-width:420px}
.card h1{font-size:28px;margin-bottom:12px}
.card p{font-size:15px;color:#666;margin-bottom:8px}
.card a{display:inline-block;margin-top:16px;padding:12px 32px;background:#ff6b6b;color:#fff;text-decoration:none;border-radius:30px;font-weight:bold;font-size:16px;box-shadow:3px 3px 0 #333;transition:transform .2s}
.card a:hover{transform:translateY(-2px)}
.spinner{width:40px;height:40px;border:4px solid #f0f0f0;border-top:4px solid #ff6b6b;border-radius:50%;animation:spin 1s linear infinite;margin:20px auto}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="card">
<h1>✅ 一起打卡吧</h1>
<div class="spinner"></div>
<p>正在跳转到打卡清单...</p>
<p style="font-size:13px;color:#999;margin-top:12px">如果未自动跳转，请点击下方按钮</p>
<a href="${URL}">进入打卡清单 →</a>
</div>
</body>
</html>
REDIRECT_EOF

# 通过 GitHub API 更新 index.html
CONTENT=$(base64 -w0 < /tmp/redirect.html)

# 获取当前文件 sha（如果文件已存在）
SHA=$(curl -s -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/index.html" 2>/dev/null \
  | grep -oE '"sha":"[^"]*"' | head -1 | cut -d'"' -f4 || true)

if [ -n "$SHA" ]; then
  BODY="{\"message\":\"auto: update redirect URL\",\"content\":\"${CONTENT}\",\"sha\":\"${SHA}\"}"
else
  BODY="{\"message\":\"auto: create redirect page\",\"content\":\"${CONTENT}\"}"
fi

RESPONSE=$(curl -s -X PUT \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/index.html" \
  -d "$BODY" 2>&1)

if echo "$RESPONSE" | grep -q '"content"'; then
  echo "✅ 跳转页面已更新！"
  echo "   永久入口: https://12siii.github.io/silver/"
else
  echo "⚠️ 跳转页面更新失败（不影响当前使用）"
  echo "$RESPONSE" | head -5
fi

# 保持进程存活，维持隧道开放
echo ""
echo "服务器与隧道运行中...保持连接中（最长 6 小时）"
while true; do sleep 300; done
