# 🍪 CookieBoard

**一个跑在 [Cookie Chain](https://www.cookiechain.wtf) 上的链上留言板（cApp）。**

连接你的 SVM 钱包，写下一句话 —— 它会作为一笔**真实的链上交易**（Solana Memo 指令）永久记录在 Cookie Chain 上，并可从链上历史随时读回。亚秒确认，手续费不到一分钱。

> 这是一个完全运行在 Cookie Chain 主网上的 Web 应用：钱包连接、交易构造与签名、交易确认、错误处理、链上数据回溯，全部为真实实现，**不依赖任何后端服务**。
>
> **不装钱包也能用**：首屏的「最新链上动态」直接读取链上 Memo 程序，任何人打开就能看到这条链正在发生什么。

---

## ✨ 功能

| 功能 | 说明 |
|---|---|
| **钱包连接** | 基于 Wallet Standard 自动发现钱包（**Nightly**、Phantom、Solflare、Backpack…），并兼容传统注入式 provider |
| **地址展示** | 显示已连接地址（含 CookieScan 链接）与原生代币余额 |
| **写入留言** | 构造 Memo 指令，交由钱包签名并广播到 Cookie Chain |
| **交易状态** | 全链路反馈：准备 → 签名 → 广播 → 确认 → 成功/失败，附交易哈希与浏览器链接 |
| **链上回溯** | 读回该地址写过的所有留言（含时间与浏览器链接） |
| **全链动态（无需钱包）** | 实时读取链上 Memo 程序的最近记录，展示正文、作者、时间与交易哈希 |
| **网络状态** | 实时显示节点健康、出块高度、链上交易总数、`solana-core` 版本 |

## 🧱 技术栈

- **[Cookie Chain RPC](https://rpc.cookiescan.io)** —— Solana 兼容 SVM，`solana-core 4.1.2`
- **[@solana/web3.js](https://github.com/anza-xyz/solana-web3.js)** —— 连接、构造与发送交易
- **[@wallet-standard/app](https://github.com/wallet-standard/wallet-standard)** —— 钱包发现（Nightly 支持）
- **[Vite](https://vitejs.dev)** —— 构建工具（纯静态产物，可托管到任意静态服务）

### 链上交互细节

- **程序**：`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`（Solana Memo 程序，已在 Cookie Chain 部署）
- **指令数据**：UTF-8 编码的留言文本（≤ 180 字符）
- **签名者**：用户钱包地址
- **链标识**：`solana:9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2`（该 genesis hash 是 Cookie Chain 的链身份，签名时优先采用钱包为该账户声明的链）

## ⚠️ Cookie Chain RPC 兼容性（实测踩坑记录）

在把应用接到 Cookie Chain 的过程中，发现两个必须绕开的坑。记录下来，免得下一个人再踩：

**坑 1：节点没有 `getParsedTransaction`**

```jsonc
// POST https://rpc.cookiescan.io
{"jsonrpc":"2.0","id":1,"method":"getParsedTransaction","params":["<sig>",{"maxSupportedTransactionVersion":0}]}
// → {"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found"},"id":1}
```

所以 `connection.getParsedTransaction()` 在这条链上必然失败。

**坑 2：`getTransaction` 也不能用 `jsonParsed` 编码（@solana/web3.js v1 的限制）**

`connection.getTransaction(sig, { encoding: 'jsonParsed' })` 会直接抛异常：

```
StructError: At path: transaction.message.accountKeys.0
  -- Expected a string, but received: [object Object]
```

原因是该编码下 `accountKeys` 返回的是对象数组 `{pubkey, signer, ...}`，而 web3.js v1 的结构校验器要求它是字符串数组。**这是 SDK 侧的限制，不是节点的问题。**

**本项目的解法**

- 读链上数据一律走**原始 JSON-RPC**（`rpc()` / `rpcBatch()`），只在构造交易、签名、发送时使用 `@solana/web3.js`。
- 读留言优先用 `getSignaturesForAddress` **自带返回的 `memo` 字段**（一个请求搞定，实测覆盖率 100%），需要时再回退到原始 RPC 的 `getTransaction`。
- 作者地址用 **JSON-RPC 批量请求**一次取回（该节点支持 batch），12 条记录只需 1 次 HTTP 往返。
- 注意 `getSignaturesForAddress` 返回的 `memo` 带字节长度前缀，形如 `"[63] 正文"`，需剥掉。

**节点能力实测小结**

| 方法 | 可用 |
|---|---|
| `getSignaturesForAddress` / `getTransaction` / `getAccountInfo` / `getBalance` | ✅ |
| `getLatestBlockhash` / `getSignatureStatuses` / `getVersion` / `getEpochInfo` / `getHealth` / `getGenesisHash` | ✅ |
| JSON-RPC 批量请求（batch） | ✅ |
| `getParsedTransaction` | ❌ `Method not found` |

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

`dist/` 是纯静态文件，可直接部署到 Vercel / Netlify / Cloudflare Pages / GitHub Pages 或任意静态服务器。构建产物使用**相对路径**引用资源（`./assets/…`），部署到任意子路径都不会 404。

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
