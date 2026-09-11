/**
 * CookieBoard — 链上留言板 (cApp on Cookie Chain)
 *
 * 核心流程：
 *   连接钱包 → 构造 Memo 指令 → 钱包签名并发送 → 等待确认 → 上链
 *
 * 亮点：
 *   1. Wallet Standard 发现钱包（含 Nightly），并兼容传统注入式 provider
 *   2. 交易状态全链路反馈（准备 / 签名 / 广播 / 确认 / 失败）
 *   3. 从链上回溯用户写过的留言
 *   4. 公开链上动态：**无需连接钱包**即可读取全链最新 Memo 记录
 *
 * ─────────────────────────────────────────────────────────────
 * Cookie Chain RPC 兼容性说明（对 rpc.cookiescan.io 实测，两个坑都踩过）
 *
 *   节点支持：getSignaturesForAddress / getTransaction / getAccountInfo / getBalance /
 *            getLatestBlockhash / getSignatureStatuses / getVersion / getEpochInfo /
 *            getHealth / getGenesisHash / getFeeForMessage / JSON-RPC 批量请求
 *   节点不支持：getParsedTransaction → {"error":{"code":-32601,"message":"Method not found"}}
 *
 *   坑 1：不能用 connection.getParsedTransaction() —— 节点根本没实现这个方法。
 *   坑 2：也不能用 connection.getTransaction(sig, {encoding:'jsonParsed'}) ——
 *         @solana/web3.js v1 会对返回结构做超严格校验，而 jsonParsed 返回的
 *         accountKeys 是对象数组（{pubkey,signer,...}），校验器要求是字符串，
 *         于是直接抛 StructError：Expected a string, but received [object Object]。
 *
 *   因此本应用读取链上数据一律走**原始 JSON-RPC**（下方 rpc / rpcBatch），
 *   只在构造交易、签名、发交易这些真正需要 SDK 的地方使用 @solana/web3.js。
 *   读留言的两条路，按优先级：
 *     A. getSignaturesForAddress 返回的条目自带 `memo` 字段（实测覆盖率 100%，最快）
 *     B. 回退到原始 RPC 的 getTransaction(encoding:'jsonParsed')，从已解析指令取 Memo
 * ─────────────────────────────────────────────────────────────
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { getWallets } from '@wallet-standard/app';
import bs58 from 'bs58';

// ------------------------------------------------------------------ 常量
const RPC_ENDPOINT = 'https://rpc.cookiescan.io';
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MEMO_PROGRAM_STR = MEMO_PROGRAM_ID.toBase58();

/** 链身份：钱包用 genesis hash 认链（solana:<genesisHash>），不是 solana:mainnet */
const GENESIS_HASH = '9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2';
const CHAIN_ID = `solana:${GENESIS_HASH}`;

const EXPLORER = 'https://cookiescan.io';
const EXPLORER_TX = `${EXPLORER}/tx/`;
const EXPLORER_ADDR = `${EXPLORER}/address/`;

const MAX_LEN = 180;
const FEED_SIZE = 12;

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const { get: getStandardWallets } = getWallets();

// ------------------------------------------------------------------ 原始 JSON-RPC
/**
 * 直接打节点，绕过 @solana/web3.js 的结构校验。
 * 见文件头「兼容性说明」：web3.js v1 处理不了 jsonParsed 返回的 accountKeys 结构。
 */
async function rpc(method, params = []) {
  const res = await fetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'RPC error');
  return json.result;
}

/** 批量请求：一次 HTTP 换取 N 个结果（节点支持 JSON-RPC batch） */
async function rpcBatch(calls) {
  if (!calls.length) return [];
  const res = await fetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }))
    ),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const arr = await res.json();
  const out = new Array(calls.length).fill(null);
  for (const item of Array.isArray(arr) ? arr : [arr]) {
    if (item && typeof item.id === 'number') out[item.id] = item.result ?? null;
  }
  return out;
}

// ------------------------------------------------------------------ DOM
const $ = (id) => document.getElementById(id);
const ui = {
  netDot: $('net-dot'),
  netText: $('net-text'),
  blockHeight: $('block-height'),
  coreVer: $('core-ver'),
  txTotal: $('tx-total'),
  connectBtn: $('connect-btn'),
  walletList: $('wallet-list'),
  walletPanel: $('wallet-panel'),
  accountPanel: $('account-panel'),
  accountAddr: $('account-addr'),
  accountBalance: $('account-balance'),
  disconnectBtn: $('disconnect-btn'),
  memoInput: $('memo-input'),
  postBtn: $('post-btn'),
  charCount: $('char-count'),
  status: $('status'),
  board: $('board'),
  refreshBtn: $('refresh-btn'),
  feed: $('feed'),
  feedRefreshBtn: $('feed-refresh'),
  feedCount: $('feed-count'),
};

// ------------------------------------------------------------------ 状态
const state = {
  wallet: null,   // Wallet Standard 钱包对象
  account: null,  // Wallet Standard 账户
  provider: null, // 传统注入式 provider
  address: null,
  kind: null,     // 'standard' | 'legacy'
  busy: false,
  feedLoaded: false,
};
/** 作者地址缓存：signature -> 地址（避免重复请求交易详情） */
const authorCache = new Map();

// ------------------------------------------------------------------ 工具
const short = (a, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : '—');

const fmtTime = (blockTime) =>
  blockTime ? new Date(blockTime * 1000).toLocaleString('zh-CN') : '未知时间';

const agree = (blockTime) => {
  if (!blockTime) return '';
  const diff = Math.floor(Date.now() / 1000) - blockTime;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
};

/**
 * getSignaturesForAddress 返回的 memo 会带一个字节长度前缀，例如 "[63] 正文"。
 * 这里剥掉它，拿到干净的留言正文。
 */
const stripMemoPrefix = (memo) =>
  typeof memo === 'string' ? memo.replace(/^\[\d+\]\s*/, '') : '';

function setStatus(text, type = 'info', link) {
  ui.status.className = `status status-${type}`;
  ui.status.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text;
  ui.status.appendChild(span);
  if (link) {
    const a = document.createElement('a');
    a.href = link;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = ' 查看交易 ↗';
    a.className = 'status-link';
    ui.status.appendChild(a);
  }
}
const clearStatus = () => {
  ui.status.className = 'status';
  ui.status.textContent = '';
};

/** 从交易详情里取签名者地址（fee payer = accountKeys[0]） */
function payerOf(tx) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  const first = keys[0];
  return typeof first === 'string' ? first : first?.pubkey || null;
}

// ------------------------------------------------------------------ 网络状态
async function loadNetwork() {
  try {
    const [height, version, epochInfo] = await Promise.all([
      connection.getBlockHeight('confirmed'),
      connection.getVersion(),
      connection.getEpochInfo('confirmed').catch(() => null),
    ]);
    ui.netDot.className = 'dot dot-ok';
    ui.netText.textContent = 'Cookie Chain 节点正常';
    ui.blockHeight.textContent = height.toLocaleString();
    ui.coreVer.textContent = `core ${version['solana-core'] || '—'}`;
    if (epochInfo?.transactionCount != null && ui.txTotal) {
      ui.txTotal.textContent = Number(epochInfo.transactionCount).toLocaleString();
    }
  } catch (err) {
    ui.netDot.className = 'dot dot-bad';
    ui.netText.textContent = '节点连接失败';
    console.error('[network]', err);
  }
}

// ------------------------------------------------------------------ 钱包发现
function collectWallets() {
  const found = [];
  const seen = new Set();

  // 1) Wallet Standard（Nightly / Phantom / Solflare / Backpack 均走这里）
  for (const w of getStandardWallets()) {
    const f = w.features || {};
    if (f['standard:connect'] && f['solana:signAndSendTransaction']) {
      found.push({ kind: 'standard', name: w.name, icon: w.icon, wallet: w });
      seen.add(w.name.toLowerCase());
    }
  }

  // 2) 传统注入式 provider（作为兜底）
  const legacy = [
    ['Nightly', window.nightly?.solana || window.nightly],
    ['Phantom', window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null)],
    ['Solflare', window.solflare],
    ['Backpack', window.backpack],
  ];
  for (const [name, p] of legacy) {
    if (p && typeof p.connect === 'function' && !seen.has(name.toLowerCase())) {
      found.push({ kind: 'legacy', name, provider: p });
    }
  }
  return found;
}

function renderWalletList(wallets) {
  ui.walletList.innerHTML = '';
  if (!wallets.length) {
    ui.walletList.classList.remove('hidden');
    ui.walletList.innerHTML =
      '<p class="hint">未检测到钱包。想发留言，请安装 ' +
      '<a href="https://nightly.app" target="_blank" rel="noreferrer">Nightly</a> 或 Phantom 后刷新页面；' +
      '只想看链上动态的话，不需要钱包。</p>';
    return;
  }
  for (const w of wallets) {
    const btn = document.createElement('button');
    btn.className = 'wallet-item';
    if (w.icon) {
      const img = document.createElement('img');
      img.src = w.icon;
      img.alt = w.name;
      btn.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'wallet-ph';
      ph.textContent = '◈';
      btn.appendChild(ph);
    }
    const label = document.createElement('span');
    label.textContent = w.name;
    btn.appendChild(label);
    btn.addEventListener('click', () => connectWallet(w));
    ui.walletList.appendChild(btn);
  }
  ui.walletList.classList.remove('hidden');
}

// ------------------------------------------------------------------ 连接 / 断开
async function connectWallet(w) {
  if (state.busy) return;
  state.busy = true;
  setStatus(`正在连接 ${w.name}…`, 'info');
  try {
    let address;
    if (w.kind === 'standard') {
      const out = await w.wallet.features['standard:connect'].connect();
      const acct = out.accounts?.[0];
      if (!acct) throw new Error('钱包未返回任何账户');
      state.wallet = w.wallet;
      state.account = acct;
      address = acct.address;
      watchWalletEvents(w.wallet);
    } else {
      const res = await w.provider.connect();
      const pk = res?.publicKey || w.provider.publicKey;
      if (!pk) throw new Error('钱包未返回公钥');
      state.provider = w.provider;
      address = pk.toString();
    }
    state.address = address;
    state.kind = w.kind;
    reflectConnected(w.name, address);

    setStatus(`已连接 ${w.name}`, 'ok');
    await Promise.all([refreshBalance(), loadMemos()]);
  } catch (err) {
    console.error('[connect]', err);
    setStatus(`连接失败：${err?.message || err}`, 'bad');
  } finally {
    state.busy = false;
  }
}

function reflectConnected(name, address) {
  ui.walletPanel.classList.add('hidden');
  ui.disconnectBtn.classList.remove('hidden');
  ui.accountPanel.classList.remove('hidden');
  ui.accountAddr.textContent = short(address, 6);
  ui.accountAddr.href = EXPLORER_ADDR + address;
  ui.accountAddr.title = address;
  ui.postBtn.disabled = false;
  ui.disconnectBtn.textContent = `断开 ${name}`;
}

/** 监听钱包账户切换 / 断开，保持界面与钱包一致 */
function watchWalletEvents(wallet) {
  const events = wallet.features?.['standard:events'];
  if (!events?.on) return;
  events.on('change', ({ accounts }) => {
    const acct = accounts?.[0];
    if (!acct) {
      disconnect();
      return;
    }
    if (acct.address === state.address) return;
    state.account = acct;
    state.address = acct.address;
    reflectConnected(wallet.name, acct.address);
    setStatus('钱包账户已切换', 'ok');
    Promise.all([refreshBalance(), loadMemos()]);
  });
}

async function disconnect() {
  try {
    if (state.kind === 'standard' && state.wallet) {
      await state.wallet.features['standard:disconnect']?.disconnect();
    } else if (state.provider?.disconnect) {
      await state.provider.disconnect();
    }
  } catch (err) {
    console.warn('[disconnect]', err);
  }
  Object.assign(state, { wallet: null, account: null, provider: null, address: null, kind: null });
  ui.walletPanel.classList.remove('hidden');
  ui.disconnectBtn.classList.add('hidden');
  ui.accountPanel.classList.add('hidden');
  ui.walletList.classList.add('hidden');
  ui.postBtn.disabled = true;
  ui.board.innerHTML = '<p class="empty">连接钱包后，这里会显示你写过的留言。</p>';
  clearStatus();
}

// ------------------------------------------------------------------ 余额
async function refreshBalance() {
  if (!state.address) return;
  try {
    const lamports = await connection.getBalance(new PublicKey(state.address), 'confirmed');
    ui.accountBalance.textContent = `${(lamports / 1e9).toFixed(4)} ◎`;
  } catch (err) {
    console.error('[balance]', err);
    ui.accountBalance.textContent = '读取失败';
  }
}

// ------------------------------------------------------------------ 发留言
async function postMemo() {
  const text = ui.memoInput.value.trim();
  if (!text) return setStatus('留言不能为空。', 'bad');
  if (text.length > MAX_LEN) return setStatus(`超过 ${MAX_LEN} 字符。`, 'bad');
  if (!state.address) return setStatus('请先连接钱包。', 'bad');
  if (state.busy) return;

  state.busy = true;
  ui.postBtn.disabled = true;

  try {
    setStatus('正在准备交易…', 'info');
    const from = new PublicKey(state.address);

    const ix = new TransactionInstruction({
      keys: [{ pubkey: from, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: new TextEncoder().encode(text),
    });

    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = from;

    setStatus('请在钱包中确认签名…', 'info');

    let signature;
    if (state.kind === 'standard') {
      const feature = state.wallet.features['solana:signAndSendTransaction'];
      // 优先用钱包为该账户声明的链；否则回退到 Cookie Chain 的链标识
      const chain = state.account?.chains?.[0] || CHAIN_ID;
      const outputs = await feature.signAndSendTransaction({
        account: state.account,
        chain,
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      });
      const raw = outputs?.[0]?.signature;
      if (!raw) throw new Error('钱包未返回签名');
      signature = typeof raw === 'string' ? raw : bs58.encode(raw);
    } else {
      const res = await state.provider.signAndSendTransaction(tx);
      signature = res?.signature || res;
    }

    setStatus('交易已广播，等待确认…', 'info', EXPLORER_TX + signature);
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );
    if (confirmation.value?.err) {
      throw new Error('链上执行失败：' + JSON.stringify(confirmation.value.err));
    }

    setStatus('✅ 留言已永久写入 Cookie Chain', 'ok', EXPLORER_TX + signature);
    ui.memoInput.value = '';
    updateCharCount();
    await Promise.all([loadMemos(), refreshBalance(), loadPublicFeed()]);
  } catch (err) {
    console.error('[post]', err);
    const msg = err?.message || String(err);
    setStatus(
      /reject|denied|cancel/i.test(msg) ? '你取消了签名。' : `失败：${msg}`,
      'bad'
    );
  } finally {
    state.busy = false;
    if (state.address) ui.postBtn.disabled = false;
  }
}

// ------------------------------------------------------------------ 读取：某笔交易的 Memo（兜底路径）
/**
 * 仅当 getSignaturesForAddress 没带 memo 字段时才调用。
 * 走原始 RPC —— 既避开节点未实现的 getParsedTransaction，
 * 也避开 web3.js v1 对 jsonParsed 结构的校验异常。
 */
async function fetchMemoByTx(signature) {
  let tx;
  try {
    tx = await rpc('getTransaction', [
      signature,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
    ]);
  } catch {
    return null;
  }
  if (!tx) return null;

  // 1) 已解析指令里直接拿
  for (const ix of tx.transaction?.message?.instructions || []) {
    if (ix.programId === MEMO_PROGRAM_STR && typeof ix.parsed === 'string') return ix.parsed;
  }
  // 2) 从程序日志里抓
  for (const line of tx.meta?.logMessages || []) {
    const m = /Program log: Memo \(len \d+\): "(.*)"$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

// ------------------------------------------------------------------ 读取：我的留言
async function loadMemos() {
  if (!state.address) return;
  ui.board.innerHTML = '<p class="empty">读取链上记录…</p>';
  try {
    const pk = new PublicKey(state.address);
    const sigs = await connection.getSignaturesForAddress(pk, { limit: 20 }, 'confirmed');

    const rows = [];
    for (const s of sigs) {
      if (s.err) continue;
      // 路径 A：签名列表自带 memo（实测 Cookie Chain 会返回）
      let text = stripMemoPrefix(s.memo);
      // 路径 B：兜底
      if (!text) {
        try {
          text = (await fetchMemoByTx(s.signature)) || '';
        } catch {
          text = '';
        }
      }
      if (text) {
        rows.push({ text, sig: s.signature, blockTime: s.blockTime });
      }
    }

    if (!rows.length) {
      ui.board.innerHTML = '<p class="empty">还没有留言，写下第一条吧。</p>';
      return;
    }
    ui.board.innerHTML = '';
    for (const r of rows) {
      ui.board.appendChild(memoItem(r, { showAuthor: false }));
    }
  } catch (err) {
    console.error('[memos]', err);
    ui.board.innerHTML = `<p class="empty">读取失败：${err?.message || err}</p>`;
  }
}

// ------------------------------------------------------------------ 读取：全链公开动态（无需钱包）
async function loadPublicFeed() {
  ui.feed.innerHTML = '<p class="empty">读取链上最新记录…</p>';
  try {
    // 直接读 Memo 程序的最近签名 —— 不需要任何钱包，也不需要 getParsedTransaction
    const sigs = await connection.getSignaturesForAddress(
      MEMO_PROGRAM_ID,
      { limit: FEED_SIZE },
      'confirmed'
    );

    const rows = [];
    for (const s of sigs) {
      if (s.err) continue;
      const text = stripMemoPrefix(s.memo);
      if (!text) continue;
      rows.push({ text, sig: s.signature, blockTime: s.blockTime, author: authorCache.get(s.signature) });
    }

    if (!rows.length) {
      ui.feed.innerHTML = '<p class="empty">暂时读不到链上记录。</p>';
      return;
    }

    ui.feedCount.textContent = `最新 ${rows.length} 条`;
    ui.feed.innerHTML = '';
    for (const r of rows) {
      ui.feed.appendChild(memoItem(r, { showAuthor: true, author: r.author }));
    }
    state.feedLoaded = true;

    // 异步补齐作者地址（渐进增强，不阻塞首屏）
    enrichAuthors(rows);
  } catch (err) {
    console.error('[feed]', err);
    ui.feed.innerHTML = `<p class="empty">读取失败：${err?.message || err}</p>`;
  }
}

/**
 * 补齐作者地址：取交易详情里的 fee payer（= 签名者）。
 * 用**一次批量请求**拿全部结果，而不是逐条打 RPC —— 首屏更快，也更不容易被限流。
 */
async function enrichAuthors(rows) {
  const pending = rows.filter((r) => !r.author && !authorCache.has(r.sig));
  if (!pending.length) return;

  let results;
  try {
    results = await rpcBatch(
      pending.map((r) => ({
        method: 'getTransaction',
        params: [r.sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }],
      }))
    );
  } catch (err) {
    console.warn('[feed] 作者地址解析失败（非致命）', err);
    return;
  }

  pending.forEach((r, i) => {
    const addr = payerOf(results[i]);
    if (!addr) return;
    authorCache.set(r.sig, addr);
    const el = document.querySelector(`[data-sig="${r.sig}"] .memo-author`);
    if (el) {
      el.textContent = short(addr, 4);
      el.title = addr;
      el.href = EXPLORER_ADDR + addr;
      el.classList.remove('hidden');
    }
  });
}

/** 渲染一条留言卡片 */
function memoItem(row, { showAuthor = false, author = null } = {}) {
  const item = document.createElement('div');
  item.className = 'memo';
  item.dataset.sig = row.sig;

  const p = document.createElement('p');
  p.className = 'memo-text';
  p.textContent = row.text;

  const meta = document.createElement('div');
  meta.className = 'memo-meta';

  const left = document.createElement('div');
  left.className = 'memo-left';
  const when = document.createElement('span');
  when.textContent = fmtTime(row.blockTime);
  const ago = document.createElement('span');
  ago.className = 'memo-ago';
  ago.textContent = agree(row.blockTime);
  left.appendChild(when);
  left.appendChild(ago);

  if (showAuthor) {
    const a = document.createElement('a');
    a.className = 'memo-author mono' + (author ? '' : ' hidden');
    a.href = author ? EXPLORER_ADDR + author : '#';
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = author ? short(author, 4) : '';
    a.title = author || '';
    left.appendChild(a);
  }

  const link = document.createElement('a');
  link.href = EXPLORER_TX + row.sig;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.className = 'mono';
  link.textContent = short(row.sig, 6);

  meta.appendChild(left);
  meta.appendChild(link);
  item.appendChild(p);
  item.appendChild(meta);
  return item;
}

// ------------------------------------------------------------------ 输入计数
function updateCharCount() {
  ui.charCount.textContent = `${ui.memoInput.value.length} / ${MAX_LEN}`;
}

// ------------------------------------------------------------------ 事件绑定
ui.connectBtn.addEventListener('click', () => {
  const wallets = collectWallets();
  renderWalletList(wallets);
  if (wallets.length === 1) connectWallet(wallets[0]);
});
ui.disconnectBtn.addEventListener('click', disconnect);
ui.postBtn.addEventListener('click', postMemo);
ui.refreshBtn.addEventListener('click', loadMemos);
ui.feedRefreshBtn.addEventListener('click', loadPublicFeed);
ui.memoInput.addEventListener('input', updateCharCount);
ui.memoInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') postMemo();
});

// ------------------------------------------------------------------ 启动
loadNetwork();
updateCharCount();
loadPublicFeed();                 // 无需钱包，首屏即可看到链上实况
setInterval(loadNetwork, 30_000);
setInterval(() => {
  if (!document.hidden) loadPublicFeed();
}, 60_000);
