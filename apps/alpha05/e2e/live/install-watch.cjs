// Live review of installing the app (#3180; ACC-11; RB-INSTALL; live tier,
// run after each deploy). The deployed build must serve its manifest with the
// four shortcuts and every icon, register its service worker, keep in the
// worker's store only files from this build's `assets/`, and answer neither a
// page load nor any other origin's request (RPC, Workers) from the worker.
// It loads the page twice (the second load runs under the worker), opens
// Settings in Advanced, and prints what it found on desktop and phone. No
// wallet is connected and nothing is signed.
// Usage: node e2e/live/install-watch.cjs  (screenshots go to $LIVE_OUT or
// /tmp; $LIVE_URL overrides the deployed origin)
const { chromium, devices } = require('playwright');
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function view(b, opts, label) {
  const ctx = await b.newContext(opts);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  const fromWorker = [];
  p.on('response', (r) => {
    if (r.fromServiceWorker()) fromWorker.push(r.url());
  });
  const manifest = await (await p.request.get(`${ORIGIN}manifest.webmanifest`)).json();
  console.log(`===== ${label}`);
  console.log('manifest shortcuts:', manifest.shortcuts.map((s) => s.url).join(', '));
  for (const icon of manifest.icons) {
    const r = await p.request.get(new URL(icon.src, ORIGIN).href);
    console.log(`icon ${icon.src} (${icon.purpose}): ${r.status()} ${r.headers()['content-type']}`);
  }
  await p.goto(ORIGIN, { waitUntil: 'networkidle' });
  const registered = await p.evaluate(() => navigator.serviceWorker.ready.then((r) => r.active?.scriptURL ?? null));
  console.log('worker:', registered);
  const nav = await p.goto(`${ORIGIN}settings`, { waitUntil: 'networkidle' });
  console.log('page load answered by the worker:', nav.fromServiceWorker());
  const stores = await p.evaluate(async () => {
    const out = {};
    for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  });
  for (const [k, files] of Object.entries(stores)) console.log(`store ${k}: ${files.length} files; outside assets/: ${JSON.stringify(files.filter((f) => !f.startsWith('/assets/')))}`);
  const foreign = fromWorker.filter((u) => !u.startsWith(ORIGIN) || !new URL(u).pathname.startsWith('/assets/'));
  console.log(`answered by the worker: ${fromWorker.length}; not this build's assets: ${JSON.stringify(foreign)}`);
  await p.getByTestId('settings-mode').getByRole('button', { name: 'Advanced' }).click();
  const section = p.getByTestId('settings-install');
  await section.waitFor({ timeout: 30000 });
  console.log(`--- section: ${(await section.innerText()).replace(/\n+/g, ' · ')}`);
  await section.screenshot({ path: `${OUT}/live-install-${label}.png` });
  console.log('errors:', JSON.stringify(errs));
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await view(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await view(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
