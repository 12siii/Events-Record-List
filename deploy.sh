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
echo "     • 此链接最长有效期 6 小时 (GitHub Actions 限制)"
echo "     • 到期后请在 Actions 页面重新运行此 workflow"
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
  echo "### 功能一览"
  echo "- 📝 创建打卡清单，支持设定目标件数"
  echo "- 👥 邀请好友一起协作（分享 token 链接）"
  echo "- 🔀 任务支持拖拽排序"
  echo "- 🖼️ 完成任务需上传图片，双方互相确认"
  echo "- 🎨 打卡结束生成纪念册（按完成顺序展示照片）"
  echo "- 👤 支持单人模式，独立完成目标"
  echo "- 🏠 主页展示进行中 / 已完成清单"
  echo "- ⏹️ 随时可提前结束打卡"
  echo ""
  echo "### ⏰ 有效期"
  echo "此链接最长可用 **6 小时**（GitHub Actions 免费运行时长限制）。到期后请回到 Actions 页面重新运行此 workflow，即可获得新链接。"
} >> "$GITHUB_STEP_SUMMARY"

# 保持进程存活，维持隧道开放
echo ""
echo "服务器与隧道运行中...保持连接中（最长 6 小时）"
while true; do sleep 300; done
