// #2089 post-deploy review — the robots policy in the RESPONSE headers, as
// a visitor with no wallet. Read-only; sends nothing, needs no keys.
//
//   SITE_URL=https://<the deployment you just made> node e2e/live/live-robots-headers.mjs
//
// CONSOLE_PUBLIC=false when the deployment was built with
// VITE_ADMIN_DASHBOARD_PUBLIC=false: that flag adds one rule (see
// scripts/headersPolicy.mjs), and the drive cannot read a build's flags.
// Unset means the default, public console — the retail deploy.
//
// The app's noindex policy is a header (`_headers`), because the
// `<meta name="robots">` SeoMeta writes exists only after hydration and a
// crawler that does not run JavaScript never sees it. This drive asks the
// DEPLOYED site for every path that policy names and checks the
// `X-Robots-Tag` each response carries against the policy a build composes
// from the committed `_headers.base` — never the generated, gitignored
// `public/_headers`, which reflects whichever build last ran here
// (`robotsHeaders.mjs` derives the probes): a wallet-gated
// route carries noindex, a public route's soft-404 children carry noindex,
// `/nft/<id>` carries noindex while `/nft` does not, and the root carries
// none.
//
// Exit 0 PASS, 1 FAIL (a served response carried the wrong robots header,
// or was not served as a page), 2 BLOCKED (the site could not be reached,
// or the committed policy could not be read).
if (process.env.LIVE_PROXY_SETUP) {
  await import(process.env.LIVE_PROXY_SETUP);
}
import { composeHeaders, readHeadersBase } from '../../scripts/headersPolicy.mjs';
import { blockedSync, requireSiteUrl } from './driver.mjs';
import { parseHeadersFile, robotsDirectives, robotsProbes } from './robotsHeaders.mjs';

const site = requireSiteUrl().replace(/\/+$/, '');

let probes;
try {
  const consolePublic = (process.env.CONSOLE_PUBLIC ?? '').toLowerCase() !== 'false';
  probes = robotsProbes(parseHeadersFile(composeHeaders(readHeadersBase(), { consolePublic })));
} catch (err) {
  blockedSync(`could not read the committed robots policy: ${err.message ?? err}`);
}
if (probes.length < 2) blockedSync('the committed policy produced no probes to check');

let fails = 0;
for (const probe of probes) {
  let res;
  try {
    res = await fetch(`${site}${probe.path}`, { redirect: 'manual' });
  } catch (err) {
    blockedSync(`could not reach ${site}${probe.path}: ${err.message ?? err}`);
  }
  const got = robotsDirectives(res.headers.get('x-robots-tag'));
  const want = probe.expected;
  const shown = (d) => (d.length ? d.join(', ') : 'none');
  if (res.status !== 200) {
    // Every probed path is served the app shell by the SPA fallback; a
    // redirect or an error is a routing change this policy does not
    // describe, and its headers would not answer the question.
    console.log(`FAIL ${probe.path} — served ${res.status}, not the page (${probe.why})`);
    fails++;
    continue;
  }
  const ok = got.length === want.length && got.every((d, i) => d === want[i]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${probe.path} — X-Robots-Tag ${shown(got)}, policy ${shown(want)} (${probe.why})`);
  if (!ok) fails++;
}
console.log(`\n${probes.length} path(s) checked against the committed robots policy, ${fails} wrong.`);
process.exit(fails > 0 ? 1 : 0);
