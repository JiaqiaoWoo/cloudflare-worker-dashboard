# 🚀 NEBULA — Cloudflare Worker Personal Dashboard

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Cloudflare%20Workers-orange?logo=cloudflare&style=flat-square" alt="Cloudflare Workers">
  <img src="https://img.shields.io/github/license/loLollipop/cloudflare-worker-dashboard?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/Author-loLollipop-blueviolet?style=flat-square" alt="Author">
</p>

一个基于 Cloudflare Workers 构建的个人导航控制台：**极简、可自助配置、支持拖拽排序**，并且默认带登录保护。

无需服务器、无需数据库，使用 Cloudflare KV 在边缘存储你的分类与链接，免费部署属于你的个人入口。

> **Demo / 预览**
>
> ![Dashboard Preview](screenshots/preview.png)

---

## ✨ 项目亮点

- **⚡ Serverless 架构**：部署在 Cloudflare Workers，边缘节点就近访问。
- **🔒 登录保护 + 强制改密**：
  - 首次登录默认账号：`admin / admin123456`
  - 登录后会进入“修改密码”页，密码以 **SHA-256 哈希**保存到 KV（不会在代码里明文出现）。
- **🧠 自助配置（无需改代码）**：
  - 在页面内新增/编辑/删除链接
  - 支持“新建分类”，并可随时重命名
  - 图标自动同步（favicon）
- **🖱️ 交互体验**：
  - 鼠标滚轮切换分类（像翻页一样）
  - 分类排序（管理面板拖拽）
  - 链接拖拽排序、跨分类拖拽移动
- **🌗 亮色/暗色主题**：一键切换并记住偏好（localStorage），默认跟随系统。

---

## 🚀 快速部署（Copy & Paste）

你不需要安装任何本地环境，只需浏览器即可完成部署。

### 1) 创建 Worker

1. 登录 Cloudflare 控制台
2. 左侧：**Workers & Pages → Overview → Create Application → Create Worker**
3. 取一个名字（例如 `nebula`）点击 **Deploy**
4. 点击 **Edit code**
5. 把仓库里的 `worker.js` 全部复制粘贴覆盖
6. **先不要急着 Deploy**，继续做 KV/Secret 配置（下面两步）

---

## 🧱 必需配置（KV + Secret）

本项目依赖：

- KV 命名空间：`LINKS`（存储分类与链接）
- KV 命名空间：`AUTH`（存储登录账号与密码哈希）
- Secret：`SESSION_SECRET`（签名 Cookie Session）

### 2) 创建 KV 命名空间

Cloudflare 控制台 → **Storage & Databases → KV** → Create a namespace

创建两个：

- `nebula_links`
- `nebula_auth`

### 3) 绑定 KV 到 Worker

回到：**Workers & Pages → 你的 Worker → Settings → Variables**

找到 **KV Namespace Bindings**，新增两条：

| Binding name | KV Namespace |
|---|---|
| `LINKS` | `nebula_links` |
| `AUTH`  | `nebula_auth` |

> 绑定名必须是 `LINKS` / `AUTH`（代码里固定用这个）

### 4) 设置 SESSION_SECRET

同页面（Variables）找到 **Secrets** → Add secret：

- Name: `SESSION_SECRET`
- Value: 随便一串强随机（建议 32+ 位）

你可以用任意方式生成；比如直接在浏览器控制台生成也行：

```js
crypto.getRandomValues(new Uint8Array(32))
