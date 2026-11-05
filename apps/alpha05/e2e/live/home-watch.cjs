// Watch-only live review of Home (live tier, run after each deploy): an
// injected provider that reports one address and forwards reads to the
// public endpoint; it refuses every signature, so nothing can be sent.
// Usage: node e2e/live/home-watch.cjs <address>  (screenshots go to $LIVE_OUT or /tmp)
const { chromium, devices } = require('playwright');
const ADDR = process.argv[2];
const RPC = 'https://sepolia.base.org';
async function session(b, opts, label) {
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
  await ctx.addInitScript(() => {
    const listeners = {};
    const provider = {
      isMetaMask: true,
      request: async (payload) => { const r = await window.__walletRequest(payload); if (r.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; } return r.result; },
      on: (ev, fn) => { (listeners[ev] ??= []).push(fn); return provider; },
      removeListener: (ev, fn) => { listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn); return provider; },
    };
    window.ethereum = provider;
    const info = { uuid: '7a3f4b1e-9d2c-4f6a-8e5b-00000000watch', name: 'Watch', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'com.vaipakam.watch' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('https://alpha05.vaipakam.com/', { waitUntil: 'networkidle' });
  const btn = p.getByRole('button', { name: /^connect wallet$/i }).first();
  for (let i = 0; i < 10 && (await btn.isVisible().catch(() => false)); i++) { await btn.click({ timeout: 2000 }).catch(() => {}); await p.waitForTimeout(1500); const w = p.getByRole('button', { name: /watch|injected|browser wallet/i }).first(); if (await w.isVisible().catch(() => false)) await w.click().catch(() => {}); }
  await p.getByText(/^Synced .* ago through /).first().waitFor({ timeout: 90000 }).catch(() => {});
  await p.waitForTimeout(3000);
  const main = (await p.locator('main').innerText()).replace(/\n+/g, '\n');
  console.log(`===== ${label}\n${main}\nerrors: ${JSON.stringify(errs)}`);
  const width = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  console.log('scrollWidth/innerWidth', width);
  await p.screenshot({ path: `${process.env.LIVE_OUT ?? '/tmp'}/live-home-${label}.png`, fullPage: true });
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
