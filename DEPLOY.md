# 部署到 Render 让所有人访问

## 方式一：GitHub + Render（推荐，自动部署）

### 第 1 步：推送到 GitHub

1. 在 GitHub 新建仓库（例如 `daka-checklist`），**不要**勾选 README
2. 在本仓库目录执行（替换成你的仓库地址）：

```bash
git remote add origin https://github.com/你的用户名/daka-checklist.git
git branch -M main
git push -u origin main
```

### 第 2 步：在 Render 部署

1. 打开 https://render.com 注册/登录（可用 GitHub 账号登录）
2. 点 **New +** → **Web Service**
3. 选择 **Build and deploy from a Git repository** → 连接你的 GitHub 账号
4. 选中 `daka-checklist` 仓库
5. 配置：
   - **Name**: `daka-checklist`（或任意）
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
6. 点 **Create Web Service**

Render 会自动安装依赖、启动服务，约 1-2 分钟后获得公网地址：
```
https://daka-checklist.onrender.com
```

### 第 3 步：分享给好友

部署成功后，把公网地址发给好友，他们打开即可创建/加入清单。

> 项目已含 [render.yaml](render.yaml) 和 [Procfile](Procfile)，Render 会自动识别配置。

---

## 方式二：用 Render CLI 一键部署（无需 GitHub）

```bash
# 安装 CLI
npm install -g @render-ai/cli
# 登录
render login
# 在项目目录执行
render deploy
```

---

## 关键配置说明

| 项 | 值 |
|---|---|
| 运行时 | Node.js |
| 构建命令 | `npm install` |
| 启动命令 | `npm start` |
| 端口 | 自动读取 `PORT` 环境变量（[server.js](server.js#L9) 已支持） |
| WebSocket | Render 原生支持，前端 [app.js](public/app.js) 自动用 `wss://` |
| 持久化 | 免费层重启会清空 `data.json`，如需保留数据请绑定磁盘或外接 DB |

## 数据持久化（可选升级）

免费层 Render 重启会丢失本地文件。如需数据永久保存：

1. 在 Render 服务设置 → **Disks** → 添加磁盘，挂载路径 `/data`
2. 修改 [db.js](db.js#L4) 的 `DB_FILE` 指向 `/data/data.json`

或接入 PostgreSQL（Render 免费提供 90 天）。

---

## 验证部署成功

部署完成后，访问公网地址，应看到打卡清单主页。
创建清单后把链接 `https://你的地址/#/l/TOKEN` 发给好友即可协作。
