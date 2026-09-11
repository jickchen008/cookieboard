/**
 * CookieBoard — 链上留言板 (cApp on Cookie Chain)
 *
 * 核心流程：
 *   连接钱包 → 构造 Memo 指令 → 钱包签名并发送 → 等待确认 → 上链
 * 亮点：
 *   - 使用 Wallet Standard 发现钱包（含 Nightly），并兼容传统注入式 provider
 *   - 交易状态全链路反馈（准备 / 签名 / 广播 / 确认 / 失败）
 *   - 从链上历史回溯用户写过的留言（getSignaturesForAddress + getParsedTransaction）
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
const EXPLORER_TX = 'https://cookiescan.io/tx/';
const EXPLORER_ADDR = 'https://cookiescan.io/address/';
const MAX_LEN = 180;

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const { get: getStandardWallets } = getWallets();

// ------------------------------------------------------------------ DOM
const $ = (id) => document.getElementById(id);
const ui = {
  netDot: $('net-dot'),
  netText: $('net-text'),
  blockHeight: $('block-height'),
  coreVer: $('core-ver'),
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
};

// ------------------------------------------------------------------ 状态
const state = {
  wallet: null,   // Wallet Standard 钱包对象
  account: null,  // Wallet Standard 账户
  provider: null, // 传统注入式 provider
  address: null,
  kind: null,     // 'standard' | 'legacy'
  busy: false,
};

// ------------------------------------------------------------------ 工具
const short = (a, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : '—');

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

// ------------------------------------------------------------------ 网络状态
async function loadNetwork() {
  try {
    const [height, version] = await Promise.all([
      connection.getBlockHeight('confirmed'),
      connection.getVersion(),
    ]);
    ui.netDot.className = 'dot dot-ok';
    ui.netText.textContent = 'Cookie Chain 节点正常';
    ui.blockHeight.textContent = height.toLocaleString();
    ui.coreVer.textContent = `core ${version['solana-core'] || '—'}`;
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
      '<p class="hint">未检测到钱包。请安装 <a href="https://nightly.app" target="_blank" rel="noreferrer">Nightly</a> 或 Phantom 后刷新页面。</p>';
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
    } else {
      const res = await w.provider.connect();
      const pk = res?.publicKey || w.provider.publicKey;
      if (!pk) throw new Error('钱包未返回公钥');
      state.provider = w.provider;
      address = pk.toString();
    }
    state.address = address;
    state.kind = w.kind;

    ui.walletPanel.classList.add('hidden');
    ui.disconnectBtn.classList.remove('hidden');
    ui.accountPanel.classList.remove('hidden');
    ui.accountAddr.textContent = short(address, 6);
    ui.accountAddr.href = EXPLORER_ADDR + address;
    ui.accountAddr.title = address;
    ui.postBtn.disabled = false;

    setStatus(`已连接 ${w.name}`, 'ok');
    await Promise.all([refreshBalance(), loadMemos()]);
  } catch (err) {
    console.error('[connect]', err);
    setStatus(`连接失败：${err?.message || err}`, 'bad');
  } finally {
    state.busy = false;
  }
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
      const chain = state.account.chains?.[0] || 'solana:mainnet';
      const outputs = await feature.signAndSendTransaction({
        account: state.account,
        chain,
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      });
      const raw = outputs?.[0]?.signature;
      if (!raw) throw new Error('钱包未返回签名');
      signature = bs58.encode(raw);
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
    await Promise.all([loadMemos(), refreshBalance()]);
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

// ------------------------------------------------------------------ 读取历史留言
async function loadMemos() {
  if (!state.address) return;
  ui.board.innerHTML = '<p class="empty">读取链上记录…</p>';
  try {
    const pk = new PublicKey(state.address);
    const sigs = await connection.getSignaturesForAddress(pk, { limit: 15 }, 'confirmed');
    const rows = [];
    for (const s of sigs) {
      if (s.err) continue;
      let parsed;
      try {
        parsed = await connection.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
      } catch {
        continue;
      }
      const ixs = parsed?.transaction?.message?.instructions || [];
      const memo = ixs.find((ix) => ix.program === 'spl-memo');
      if (memo) {
        rows.push({
          text: typeof memo.parsed === 'string' ? memo.parsed : String(memo.parsed),
          sig: s.signature,
          blockTime: s.blockTime,
        });
      }
    }

    if (!rows.length) {
      ui.board.innerHTML = '<p class="empty">还没有留言，写下第一条吧。</p>';
      return;
    }
    ui.board.innerHTML = '';
    for (const r of rows) {
      const item = document.createElement('div');
      item.className = 'memo';
      const p = document.createElement('p');
      p.className = 'memo-text';
      p.textContent = r.text;
      const meta = document.createElement('div');
      meta.className = 'memo-meta';
      const when = r.blockTime
        ? new Date(r.blockTime * 1000).toLocaleString('zh-CN')
        : '未知时间';
      meta.innerHTML = `<span>${when}</span>`;
      const a = document.createElement('a');
      a.href = EXPLORER_TX + r.sig;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.className = 'mono';
      a.textContent = short(r.sig, 6);
      meta.appendChild(a);
      item.appendChild(p);
      item.appendChild(meta);
      ui.board.appendChild(item);
    }
  } catch (err) {
    console.error('[memos]', err);
    ui.board.innerHTML = `<p class="empty">读取失败：${err?.message || err}</p>`;
  }
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
ui.memoInput.addEventListener('input', updateCharCount);
ui.memoInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') postMemo();
});

// ------------------------------------------------------------------ 启动
loadNetwork();
updateCharCount();
setInterval(loadNetwork, 30_000);
