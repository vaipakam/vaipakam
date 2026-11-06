// The watch-only wallet the live drivers share: an injected provider that
// reports one address on Base Sepolia, forwards reads to the public
// endpoint, and refuses every signature, so nothing can be sent.
const RPC = 'https://sepolia.base.org';

async function watchedPage(b, opts, ADDR, DROP = false) {
  const ctx = await b.newContext(opts);
  await ctx.exposeFunction('__walletRequest', async (p) => {
    const { method, params } = p;
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return { result: [ADDR] };
    if (method === 'eth_chainId') return { result: '0x14a34' };
    if (method === 'net_version') return { result: '84532' };
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return { result: method === 'wallet_switchEthereumChain' ? null : [] };
    if (/sign|sendTransaction/i.test(method)) return { error: { code: 4001, message: 'watch-only' } };
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    return j.error ? { error: j.error } : { result: j.result };
  });
  await ctx.addInitScript((drop) => {
    const listeners = {};
    const provider = {
      isMetaMask: true,
      request: async (payload) => { const r = await window.__walletRequest(payload); if (r.error) { const e = new Error(r.error.message); e.code = r.error.code; if (!drop && r.error.data !== undefined) e.data = r.error.data; throw e; } return r.result; },
      on: (ev, fn) => { (listeners[ev] ??= []).push(fn); return provider; },
      removeListener: (ev, fn) => { listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn); return provider; },
    };
    window.ethereum = provider;
    const info = { uuid: '7a3f4b1e-9d2c-4f6a-8e5b-00000000watch', name: 'Watch', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'com.vaipakam.watch' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  }, DROP);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  return { ctx, p, errs };
}

/** Connects through the app's own wallet button, choosing the watch wallet. */
async function connect(p) {
  const btn = p.getByRole('button', { name: /^connect wallet$/i }).first();
  for (let i = 0; i < 10 && (await btn.isVisible().catch(() => false)); i++) { await btn.click({ timeout: 2000 }).catch(() => {}); await p.waitForTimeout(1500); const w = p.getByRole('button', { name: /watch|injected|browser wallet/i }).first(); if (await w.isVisible().catch(() => false)) await w.click().catch(() => {}); }
}

module.exports = { watchedPage, connect };
