/**
 * Help — short plain-language answers to the questions naive users
 * actually ask, plus the risk-disclosures section the consent
 * checkbox links to (#1030) and build info for testers. Deep-dive
 * docs stay on the marketing site; this page is deliberately small.
 */
import { lazy, Suspense, useEffect } from 'react';
import { copy } from '../content/copy';
import { supportMailto } from '../data/support';
import { formatDate } from '../lib/format';
import { useActiveChain } from '../chain/useActiveChain';
import { ErrorBoundary } from '../components/ErrorBoundary';

// UX2-008 — the live fee read (`useProtocolFees` → the Diamond ABI) is
// Help's only ABI dependency; isolating it in a lazy chunk keeps a
// direct /help visit ABI-free. The Suspense fallback below shows the
// same card with the deploy-default fee values so the answer never
// blanks.
const FeeFaqCard = lazy(() => import('./help/FeeFaqCard'));

export function Help() {
  const { isConnected } = useActiveChain();
  // FAQ content lives in the copy catalog (help.faq.*). Read in render
  // scope — a module-level read would bake in English and miss locale
  // switches (see src/i18n/reactiveCopy.ts).
  const faqItems: Array<{ q: string; a: string }> = [
    copy.help.faq.assetsHeld,
    copy.help.faq.missedRepayment,
    copy.help.faq.lenderInterest,
    copy.help.faq.nftRental,
    copy.help.faq.vpfi,
    // UX-049 — the Help page lagged the shipped features; these cover
    // Basic/Advanced modes, alert setup, Claims, wrong-network, and the
    // NFT verifier.
    copy.help.faq.modes,
    copy.help.faq.alerts,
    copy.help.faq.claimCenter,
    copy.help.faq.wrongNetwork,
    copy.help.faq.nftVerifier,
  ];
  const buildHash = import.meta.env.VITE_BUILD_HASH as string | undefined;
  const buildTime = import.meta.env.VITE_BUILD_TIME as string | undefined;
  // UX-044 — the footer shows a readable date, not the raw ISO stamp;
  // the full string stays available in the diagnostics drawer. Falls
  // back to the raw value if it doesn't parse (never hides the build).
  const buildDateText = (() => {
    if (!buildTime) return null;
    const ms = Date.parse(buildTime);
    return Number.isFinite(ms) ? formatDate(Math.floor(ms / 1000)) : buildTime;
  })();
  // The consent checkbox links here as /help#risks — the router
  // doesn't scroll to hashes on its own. getElementById, not
  // querySelector: the fragment is user-controlled and an invalid
  // selector (/help#1, encoded chars) would throw during mount.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* malformed escape — use the raw fragment */
    }
    document.getElementById(id)?.scrollIntoView();
  }, []);

  // The disconnected / loading fee card. The exact loan-initiation and
  // yield percentages are live governance-tunable config, and reading
  // them pulls the Diamond ABI (which /help stays clear of on first
  // paint, UX2-008) — so a disconnected visitor sees the fee STRUCTURE
  // in non-committal wording that directs them to connect for the exact
  // current rates, rather than a hardcoded default that could be stale
  // if governance has retuned it (Codex #1200 r2). Kept ABI-free.
  const feeFallback = (
    <section className="card">
      <h3>{copy.fees.faqQuestion}</h3>
      <p style={{ margin: 0 }}>{copy.fees.faqAnswerGeneric}</p>
    </section>
  );

  return (
    <div>
      <h1 className="page-title">{copy.help.title}</h1>
      {/* The exact platform disclaimer the spec mandates (§29) —
          wording is load-bearing, don't paraphrase. */}
      <p className="page-lede">
        {copy.help.lede} {copy.help.disclaimer}
      </p>

      <div className="stack">
        {/* The consent checkbox's "Risk Disclosures" link lands here. */}
        <section id="risks" className="card">
          <h3>{copy.help.risksTitle}</h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {copy.help.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
        {faqItems.map((item) => (
          <section key={item.q} className="card">
            <h3>{item.q}</h3>
            <p style={{ margin: 0 }}>{item.a}</p>
          </section>
        ))}
        {/* UX2-008 — the fee answer's live values need the Diamond ABI.
            `React.lazy` fetches its chunk the moment it MOUNTS, so
            mounting the live card unconditionally would pull the ABI on
            every /help visit (Codex #1200). A disconnected visitor sees
            the deploy-default fee card (correct unless governance has
            retuned, and the receipt quotes live values at transaction
            time regardless), so the live card mounts only when a wallet
            is connected — keeping a disconnected /help paint ABI-free. */}
        {isConnected ? (
          // A lazy live-fee chunk failure must degrade to the same
          // non-committal fee copy, not bubble to the route boundary and
          // replace the whole Help page (Codex #1200 r4). Its own quiet
          // boundary (fallback={feeFallback}) contains that; the Suspense
          // fallback covers the in-flight load.
          <ErrorBoundary fallback={feeFallback}>
            <Suspense fallback={feeFallback}>
              <FeeFaqCard />
            </Suspense>
          </ErrorBoundary>
        ) : (
          feeFallback
        )}
        {/* #1040 phase 1 — human escalation path. The in-app sender
            lives in the Support panel (it holds the health details a
            good report needs); this section points there and offers
            the direct mail route. */}
        <section id="contact" className="card">
          <h3>{copy.support.helpTitle}</h3>
          <p style={{ marginTop: 0 }}>{copy.support.helpBody}</p>
          <a className="btn btn-secondary" href={supportMailto({})}>
            {copy.support.mailButton}
          </a>
        </section>
      </div>

      <p className="muted" style={{ marginTop: 24 }}>
        {copy.help.buildLabel} {buildHash ?? copy.help.buildDevFallback}
        {buildDateText ? ` · ${buildDateText}` : ''}
      </p>
    </div>
  );
}
