# 🍪 CookieBoard

**一个跑在 [Cookie Chain](https://www.cookiechain.wtf) 上的链上留言板（cApp）。**

连接你的 SVM 钱包，写下一句话 —— 它会作为一笔**真实的链上交易**（Solana Memo 指令）永久记录在 Cookie Chain 上，并可从链上历史随时读回。亚秒确认，手续费不到一分钱。

> 这是一个完全运行在 Cookie Chain 主网上的 Web 应用：钱包连接、交易构造与签名、交易确认、错误处理、链上数据回溯，全部为真实实现，不依赖任何后端服务。

---

## ✨ 功能

| 功能 | 说明 |
|---|---|
| **钱包连接** | 基于 Wallet Standard 自动发现钱包（**Nightly**、Phantom、Solflare、Backpack…），并兼容传统注入式 provider |
| **地址展示** | 显示已连接地址（含 CookieScan 链接）与原生代币余额 |
| **写入留言** | 构造 Memo 指令，交由钱包签名并广播到 Cookie Chain |
| **交易状态** | 全链路反馈：准备 → 签名 → 广播 → 确认 → 成功/失败，附交易哈希与浏览器链接 |
| **链上回溯** | 通过 `getSignaturesForAddress` + `getParsedTransaction` 读回该地址写过的所有留言 |
| **网络状态** | 实时显示 Cookie Chain 节点健康、出块高度、`solana-core` 版本 |

## 🧱 技术栈

- **[Cookie Chain RPC](https://rpc.cookiescan.io)** —— Solana 兼容 SVM，`solana-core 4.1.2`
- **[@solana/web3.js](https://github.com/anza-xyz/solana-web3.js)** —— 连接、构造与发送交易
- **[@wallet-standard/app](https://github.com/wallet-standard/wallet-standard)** —— 钱包发现（Nightly 支持）
- **[Vite](https://vitejs.dev)** —— 构建工具（纯静态产物，可托管到任意静态服务）

### 链上交互细节

- **程序**：`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`（Solana Memo 程序，已在 Cookie Chain 部署）
- **指令数据**：UTF-8 编码的留言文本（≤ 180 字符）
- **签名者**：用户钱包地址

## 🚀 本地运行

```bash
npm install
npm run dev          # 打开 http://localhost:5173
```

## 📦 构建与部署

```bash
npm run build        # 产物输出到 dist/（纯静态）
npm run preview      # 本地预览构建产物
```

`dist/` 是纯静态文件，可直接部署到 Vercel / Netlify / Cloudflare Pages / GitHub Pages 或任意静态服务器。

## 🔌 在钱包中添加 Cookie Chain

为了读写 Cookie Chain，请在钱包（如 Nightly）中添加自定义 SVM 网络：

| 项 | 值 |
|---|---|
| RPC URL | `https://rpc.cookiescan.io` |
| 浏览器 | `https://cookiescan.io` |
| 代币符号 | COOKIE |

## 📁 目录结构

```
cookieboard/
├── index.html          # 页面结构
├── src/
│   ├── main.js         # 钱包连接 · 交易构造 · 链上读取（核心逻辑）
│   └── style.css       # 样式
├── vite.config.js
└── package.json
```

## 🔗 相关资源

- Cookie Chain 官网：https://www.cookiechain.wtf
- Cookie Chain 文档：https://docs.cookiechain.wtf
- CookieScan 浏览器：https://cookiescan.io
- RPC 端点：https://rpc.cookiescan.io

## 📄 License

MIT
