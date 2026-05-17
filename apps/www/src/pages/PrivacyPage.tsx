import { L as Link } from '../components/L';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { EnglishOnlyNotice } from '../components/EnglishOnlyNotice';
import { openConsentBanner } from '../lib/consent';
import { usePageMeta } from '../lib/usePageMeta';
import './LegalPage.css';

/**
 * Public Privacy Policy page — mirrors `docs/PrivacyPolicy.md`. Unlike
 * the Terms page, this content is NOT on-chain-hashed; governance can
 * update it without a protocol tx. The Privacy Policy's version bump
 * is tracked in the `.md` file's header, not on-chain.
 */
export default function PrivacyPage() {
  usePageMeta({
    titleKey: 'pageMeta.privacy.title',
    descriptionKey: 'pageMeta.privacy.description',
  });
  return (
    <>
      <Navbar />
      <main className="container legal-page">
        <EnglishOnlyNotice />
        <header>
          <h1>Vaipakam Privacy Policy</h1>
          <div className="legal-meta">
            <span>Version 2</span>
            <span>·</span>
            <span>Effective 2026-05-16</span>
          </div>
        </header>

        <section>
          <h2>What we collect</h2>
          <p>
            Vaipakam is non-custodial and has no accounts, no sign-ups,
            and no off-chain identity system. Given that, the data we
            observe about you falls into five narrow categories.
          </p>

          <p>
            <strong>On-chain activity.</strong> Your wallet address and
            the transactions it sends are public by design — every
            action you take on the protocol is visible on-chain to
            everyone. Nothing we can do (or not do) changes that. We do
            not store a separate copy of this data.
          </p>

          <p>
            <strong>Diagnostics telemetry (wallet-keyed).</strong> When
            you use the app, we collect a small journey log keyed to
            your connected wallet address. It contains timestamps,
            which screen or flow you were in, and error messages
            (truncated, with wallet addresses shortened). It is stored
            in your browser's local storage by default. If you open a
            support report from the Diagnostics drawer, a copy is
            attached to that report. We do NOT send your IP,
            user-agent, or browsing history.
          </p>

          <p>
            <strong>Server-side error capture.</strong> Every UI error
            (e.g. a transaction reverts, an oracle read fails) is
            recorded server-side at a Cloudflare Worker endpoint with
            a per-event UUID. The record carries: the redacted wallet
            (<code>0x…abcd</code>), the error type / name / selector
            and the technical error message (truncated, and free of
            anything you typed), which screen / flow / step you were
            in, your chain id, interface locale, theme, viewport size,
            and the app version. <strong>Not</strong> recorded: full
            wallet address, browser user-agent string, IP address (beyond
            transient rate-limiting), localStorage contents, cookies,
            or any free-form text you typed. The same UUID surfaces
            in any GitHub issue you choose to file, so support can
            cross-reference an external report against a real session
            on our side. Records are pruned after 90 days. The legal
            basis is "legitimate interest" (security, fraud prevention,
            and improving service reliability) under GDPR Art 6(1)(f).
            To request deletion of records associated with your
            redacted wallet, contact support.
          </p>

          <p>
            <strong>Google Analytics — only with consent.</strong> If
            you accept analytics cookies in the{' '}
            <button
              type="button"
              onClick={openConsentBanner}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--brand)',
                cursor: 'pointer',
                textDecoration: 'underline',
                font: 'inherit',
              }}
            >
              consent banner
            </button>
            , Google Analytics records anonymous usage stats: page
            views, time on page, which features you used. We use
            Google's Consent Mode v2 in Advanced mode — while you
            haven't given consent, no analytics cookies fire and
            ad-click identifiers (gclid, dclid) are redacted from
            outbound network traffic. You can change your consent at
            any time via the "Cookie settings" link in the footer.
          </p>

          <p>
            <strong>Essential cookies.</strong> Session state, theme
            preference (light/dark), chain selection, and similar UI
            housekeeping. Always on; required for the app to work.
          </p>
        </section>

        <section>
          <h2>What we do NOT collect</h2>
          <ul>
            <li>
              No KYC documents, no selfies, no passport scans.
              Vaipakam's on-chain KYC tier system records only a tier
              number (0, 1, or 2) and a country code, set by
              authorized ops — not any underlying document.
            </li>
            <li>
              No email, no phone, no social-media handle, unless you
              voluntarily type it into a public channel we don't
              operate.
            </li>
            <li>No tracking pixels beyond Google Analytics (and only with consent).</li>
            <li>No advertising identifiers.</li>
          </ul>
        </section>

        <section>
          <h2>Who we share it with</h2>
          <ul>
            <li>
              <strong>Google.</strong> Only if you consent to analytics
              cookies, and only aggregated usage data — never a
              payload tying a wallet address to a person.
            </li>
            <li>
              <strong>Nobody else by default.</strong> We do not sell
              or rent any data.
            </li>
            <li>
              <strong>Legal compliance exception.</strong> If a
              subpoena or equivalent legal order compels disclosure in
              a jurisdiction we operate in, we will comply with the
              narrowest possible scope.
            </li>
          </ul>
        </section>

        <section>
          <h2>Your rights (GDPR, UK GDPR, CCPA)</h2>
          <p>
            The following rights apply regardless of your jurisdiction;
            several are only meaningful to the extent we hold data
            about you.
          </p>
          <ul>
            <li>
              <strong>Right to access.</strong> Use the "Download my
              data" button in the app's Diagnostics drawer to export
              everything the frontend has collected about your
              session, keyed to your wallet.
            </li>
            <li>
              <strong>Right to erasure.</strong> Use the "Delete my
              data" button in the Diagnostics drawer. It clears every
              wallet-keyed journey-log entry and local-storage
              artefact on your device. Note: on-chain transactions
              are public and immutable — we have no power to erase
              them. If you want on-chain deletion, that's a wallet /
              chain-level question, not a data-processor one.
            </li>
            <li>
              <strong>Right to object.</strong> You can revoke
              analytics consent at any moment via the Cookie settings
              footer link; no further analytics data will be collected
              from that point on.
            </li>
            <li>
              <strong>Right to portability.</strong> The export from
              "Download my data" is plain JSON, intentionally portable.
            </li>
          </ul>
        </section>

        <section>
          <h2>Data transfer</h2>
          <p>
            The frontend is hosted on Cloudflare Pages. Analytics (if
            consented) are processed by Google. Both transfer data
            across borders as part of their standard operation. We do
            not transfer any additional data beyond what these tools
            inherently handle.
          </p>
        </section>

        <section>
          <h2>Data retention</h2>
          <ul>
            <li>
              Journey-log telemetry: kept in your browser's local
              storage. A slice leaves your browser only when you
              explicitly attach it to a support report. (Separately,
              a single error record — not a journey-log slice — is
              sent server-side on each error; see "Server-side error
              capture".)
            </li>
            <li>
              Server-side error records: pruned 90 days after
              capture.
            </li>
            <li>
              Consent choice: kept in your browser's local storage
              indefinitely until you revoke or clear.
            </li>
            <li>
              Google Analytics (with consent): subject to Google's own
              retention, configurable in the Analytics property
              (default: 14 months).
            </li>
          </ul>
        </section>

        <section>
          <h2>Changes to this Policy</h2>
          <p>
            We publish updates by bumping the version at the top of
            this document and announcing via the protocol's Discord
            and X channels. We do not require on-chain acceptance of
            Privacy Policy changes — the{' '}
            <Link to="/terms">Terms of Service</Link> is the
            on-chain-signed agreement, and this Policy is a companion.
          </p>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            Privacy-specific questions: via the public Discord link in
            the footer.
          </p>
        </section>
      </main>
      <Footer />
      
    </>
  );
}
