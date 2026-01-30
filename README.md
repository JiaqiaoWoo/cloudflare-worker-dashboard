# 🚀 Cloudflare Worker Personal Dashboard

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Cloudflare%20Workers-orange?logo=cloudflare&style=flat-square" alt="Cloudflare Workers">
  <img src="https://img.shields.io/github/license/JiaqiaoWoo/cloudflare-worker-dashboard?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/Author-Lollipop-blueviolet?style=flat-square" alt="Author">
</p>

一个基于 Cloudflare Workers 构建的极简、安全、响应式的个人导航控制台。
无需购买服务器，利用 Cloudflare 强大的边缘网络，免费部署属于你的个人入口。

> **Demo / 预览**
> 
> ![Dashboard Preview](screenshots/preview.png)

## ✨ 项目亮点

* **⚡️ Serverless 架构**：直接部署在 Cloudflare Workers，毫秒级响应，零成本维护。
* **🔒 内置安全验证**：基于 Cookie 的 Session 登录机制，保护你的私有链接不被公开访问。
* **🎨 现代化 UI**：
    * 动态流光背景与毛玻璃（Glassmorphism）卡片设计。
    * 平滑的 CSS 进场动画。
    * 完美适配移动端与桌面端。
* **🛠 高度可配置**：所有的链接、标题、用户信息均可在代码顶部配置区域修改。
* **📂 分类清晰**：区分“核心入口”、“私有工具”和“外部社区”三个维度。

## 🚀 快速部署 (Copy & Paste)

你不需要安装任何本地环境，只需浏览器即可完成部署。

1.  **注册/登录** [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2.  在左侧菜单选择 **Workers & Pages** -> **Overview** -> **Create Application** -> **Create Worker**。
3.  给 Worker 起个名字（例如 `xxx-worker`），点击 **Deploy**。
4.  点击 **Edit code** 进入在线编辑器。
5.  将本项目中的 [worker.js](worker.js) 的全部代码复制并粘贴覆盖编辑器中的内容。
6.  **⚠️ 重要：修改配置信息**（详见下文）。
7.  点击右上角的 **Deploy** 保存上线。

## ⚙️ 配置指南

在 `worker.js` 的顶部区域，你可以自定义所有内容。

### 1. 修改账号密码 (必填)

找到代码顶部的 `CONFIG` 对象：

```javascript
const CONFIG = {
  // 修改为你自己的登录账号
  user: "admin", 
  // 修改为你自己的登录密码 (建议复杂一点)
  pass: "your_password_here",
  
  // 网站显示的标题
  siteTitle: "xxx Space",
  siteSubtitle: "xxx控制台",
  
  // ...
};
