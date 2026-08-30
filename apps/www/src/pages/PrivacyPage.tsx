import { L as Link } from '../components/L';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { EnglishOnlyNotice } from '../components/EnglishOnlyNotice';
import { openConsentBanner } from '../lib/consent';
import { usePageMeta } from '../lib/usePageMeta';
import './LegalPage.css';

/**
 * Public Privacy Policy page — mirrors `docs/Terms/PrivacyPolicy.md`.
 * Unlike the Terms page, this content is NOT on-chain-hashed;
 * governance can update it without a protocol tx. The Privacy Policy's
 * version bump is tracked in the `.md` file's header, not on-chain.
 *
 * The mirror is maintained BY HAND — no guard compares this page with
 * the canonical Markdown (unlike the Terms pages, which are frozen
 * byte-copies checked by `check-terms-canonical-hash`). Edit both, in
 * the same commit, and keep the version/effective line in step with
 * the `.md` header.
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
            <span>Version 4</span>
            <span>·</span>
            <span>Effective 2026-08-30</span>
          </div>
        </header>

        <section>
          <h2>What we collect</h2>
          <p>
            Vaipakam is non-custodial and has no accounts, no sign-ups,
            and no off-chain identity system. Given that, the data we
            observe about you falls into seven narrow categories.
          </p>

          <p>
            <strong>On-chain activity.</strong> Your wallet address and
            the transactions it sends are public by design — every
            action you take on the protocol is visible on-chain to
            everyone. Nothing we can do (or not do) changes that. We do
            not store a separate copy of this data.
          </p>

          <p>
            <strong>Diagnostics — on your device only.</strong> Two
            kinds of failure are recorded: a screen that crashes, and a
            write action that fails. The second is broader than sent
            transactions — signing and posting a gasless offer is
            recorded the same way, including when it fails before
            anything reaches the chain. Ordinary read, network and
            validation failures are not recorded. For the failures that
            are, the app keeps a record of the most recent one — the
            error message, the component trace where it has one, the
            page you were on, and a timestamp — in your browser's
            session storage. It is a single slot, not a running log of
            your activity, it is not keyed to your wallet, and it is
            discarded when you close the tab. It never leaves your
            device on its own.
          </p>

          <p>
            The Diagnostics drawer can build a support report from it:
            a GitHub issue, pre-filled and opened in a new tab.{' '}
            <strong>Opening it sends those details to GitHub.</strong>{' '}
            They travel inside the link, so they reach GitHub at the
            moment the form opens — whether or not you go on to submit
            the issue, and whether or not you close the tab. What you
            control is whether an issue is filed, not whether GitHub
            receives the details.
          </p>

          <p>
            Read the form before opening it if that matters to you, and
            note it can carry more than the drawer previewed: the
            drawer shows the first 300 characters of the error message
            and no component trace, while the report carries up to
            1,200 characters of error text and up to 1,000 characters
            of trace. Any wallet address is shortened to{' '}
            <code>0x1234…abcd</code> first. We do NOT send your IP,
            user-agent, or browsing history.
          </p>

          <p>
            <strong>
              Error records on our servers — no automatic capture.
            </strong>{' '}
            An earlier version of the app sent a record of each UI
            error to a Cloudflare Worker endpoint automatically,
            without your involvement.{' '}
            <strong>The current app does not.</strong> Simply using the
            app creates no error record on our servers.
          </p>

          <p>
            Two things that does not mean. It does not mean no
            diagnostics ever reach us: if you send a support ticket and
            tick the attach box, the same redacted block described
            above travels with that ticket and is stored alongside it —
            see "Support tickets", which governs it. That path is
            deliberate and requires your action each time. And it does
            not make the description below obsolete: it governs records
            captured while automatic capture was running, and it must
            be accurate again before automatic capture is ever
            reinstated. Where such a record exists it carries: the
            redacted wallet (<code>0x…abcd</code>), the
            error type / name / selector and the technical error
            message (truncated, and free of anything you typed), which
            screen / flow / step you were in, your chain id, interface
            locale, theme, viewport size, and the app version.{' '}
            <strong>Not</strong> recorded: full wallet address, browser
            user-agent string, IP address (beyond transient
            rate-limiting), localStorage contents, cookies, or any
            free-form text you typed. Records are pruned after 90 days.
            The legal basis is "legitimate interest" (security, fraud
            prevention, and improving service reliability) under GDPR
            Art 6(1)(f). Your erasure control is live regardless of the
            pause: you can have the error-diagnostics records
            associated with your wallet erased at any time, directly
            and without a support ticket, by signing an erasure request
            with that wallet in the app. To make this possible a
            one-way keyed hash of your wallet address is stored
            alongside each record; your full address is used only
            momentarily to compute that hash and is never stored. In
            rare cases where the law requires us to retain specific
            records, automated erasure will skip them; where the law
            permits, we will tell you so.
          </p>

          <p>
            <strong>Support tickets — only when you send one.</strong>{' '}
            If you use the in-app "Contact support" form, we store what
            you submit on Vaipakam's support service: your message
            exactly as you typed it, the reply email address if you
            chose to give one (it is optional — a ticket works without
            it), the app page the report was sent from (with any wallet
            addresses shortened), your chain id, and — only if you
            ticked the attach box — the same redacted connection-health
            details the form showed you. Wallet addresses in the page
            field and the health details are shortened on our server as
            well, whatever the sending app did. Each ticket gets a
            reference number, shown to you. Our operators are notified
            via Telegram (our operations alert channel) that a ticket
            arrived; that notification carries only the ticket number
            and context flags (page, network, whether a reply address
            and health details were included) — never your message text
            or email address — so Telegram processes only that
            metadata. Support tickets are deleted automatically no
            later than 12 months after submission; write to
            support@vaipakam.com to have a
            ticket's contents erased earlier (we may keep the bare
            ticket number where the law requires). Like our other
            off-chain operational records, tickets are included in
            encrypted nightly backups (see "Data transfer"); backup
            copies live only in the short-cycle nightly tier (kept 30
            days), never in the long-lived monthly or yearly
            archives, so they persist at most 30 days beyond the
            ticket's deletion. The legal basis is GDPR Art 6(1)(b) —
            handling the support request you asked us to handle.
          </p>

          <p>
            <strong>Alert subscriptions — only if you link them.</strong>{' '}
            If you connect Telegram or Push alerts in the app, we
            store your wallet address, your alert preferences, your
            Telegram chat id (for Telegram), and a small per-alert
            delivery record (which loan, which level, when) so you
            are never messaged twice about the same event. Alert
            messages you subscribe to are delivered through the
            channel you chose — Telegram processes those messages for
            Telegram alerts. Unlinking removes the Telegram chat
            connection; your alert preferences and the delivery
            dedupe records (no Telegram identity in either) stay, so
            re-linking restores your setup — erasable on request via
            support@vaipakam.com.
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
              operate — or voluntarily give an optional reply email
              with an in-app support ticket (see "Support tickets"
              above; it is never required).
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
              <strong>Telegram.</strong> Two opt-in uses. If you link
              Telegram alerts, your chat id is stored and the alert
              messages you configured (loan, alert level, timing) are
              delivered through Telegram. If you send a support
              ticket, our operators are alerted through Telegram with
              the ticket number and context flags described above —
              never your message text or email address.
            </li>
            <li>
              <strong>Backblaze.</strong> Our off-chain operational
              records (server-side error records, alert subscriptions,
              support tickets) are backed up nightly to Backblaze B2.
              Archives are encrypted on our side before upload —
              Backblaze holds ciphertext only, and cannot read any of
              it.
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
              data" control on the app's Data Rights page. It exports
              the app's storage for that site plus the small amount of
              data belonging to the tab you run it from — a little is
              per-tab, so download from each open tab if you want the
              complete picture. What it exports is browser storage, not
              a wallet-keyed profile: we do not assemble one.
            </li>
            <li>
              <strong>Right to erasure.</strong> Use the "Delete my
              data" control on the same page. It clears the app's local
              storage for that site, the session storage in the tab you
              run it from, and the shared <code>vaipakam.com</code>{' '}
              preference cookies (language and theme), which are not
              per-origin. It also asks any other open tabs to clear
              their own session storage; a tab that cannot hear that
              request — an older build, or a browser without the
              messaging feature it uses — keeps its session data until
              you close it. Three further limits, stated plainly
              because a control that overstates itself is worse than
              none. First, on-chain transactions
              are public and immutable — we have no power to erase
              them, and that is a wallet / chain-level question rather
              than a data-processor one. Second, the app's own local
              and session storage IS per-origin, so clearing it does
              not reset the marketing site: that site keeps its own
              copies of your language and theme and will recreate the
              shared cookies on your next visit there. Third, erasing
              the error-diagnostics records held on our servers is a
              separate, signed request — see "Error records on our
              servers".
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
            The frontend is hosted on Cloudflare Pages, and our
            off-chain operational records live in Cloudflare's database
            service. Analytics (if consented) are processed by Google.
            Alert messages you opt into and support-ticket alert
            metadata (never ticket contents) pass through Telegram. Encrypted backups of the off-chain
            records are stored with Backblaze B2 — encrypted before
            upload, so Backblaze holds only ciphertext; nightly backup
            archives are kept 30 days and monthly archives 12 months,
            after which they age out automatically (one archive per
            calendar year is retained longer for legal-audit
            durability — support tickets are excluded from the
            monthly and yearly archives, so a ticket's backup copies
            live only in the 30-day nightly tier). All of these
            providers transfer data across borders as part of their
            standard operation. We do not transfer any additional data
            beyond what these tools inherently handle.
          </p>
        </section>

        <section>
          <h2>Data retention</h2>
          <ul>
            <li>
              Device diagnostics: the most recent error is kept in
              your browser's session storage and is discarded when you
              close the tab. It leaves your browser only by an action
              you take — opening the pre-filled GitHub report the
              Diagnostics drawer builds (which sends it to GitHub at
              that moment), or sending a support ticket with the attach
              box ticked.
            </li>
            <li>
              Server-side error records: none are being created — the
              current app sends none (see "Error records on our
              servers"). Any record created before that changed is
              pruned 90 days after its capture, and can be erased
              sooner on your signed request.
            </li>
            <li>
              Alert subscriptions: unlinking removes the Telegram
              chat connection immediately; alert preferences and
              delivery dedupe records (which carry no Telegram
              identity) are kept so re-linking restores your setup,
              and can be erased on request via support@vaipakam.com.
            </li>
            <li>
              Support tickets: deleted automatically no later than 12
              months after submission (earlier on request — see
              "Support tickets" above). Backup copies age out on the
              backup rotation schedule described under "Data
              transfer".
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
            Privacy-specific questions: via the public Discord link
            in the footer. Support tickets — including early-erasure
            requests for a ticket's contents: support@vaipakam.com.
          </p>
        </section>
      </main>
      <Footer />
      
    </>
  );
}
