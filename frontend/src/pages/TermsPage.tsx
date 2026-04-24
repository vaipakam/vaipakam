import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import DiagnosticsDrawer from "../components/app/DiagnosticsDrawer";
import "./LegalPage.css";

/**
 * Public Terms of Service page — rendered as plain JSX that mirrors
 * `docs/TermsOfService.md`. The `.md` file is the canonical source
 * that governance hashes and pins on-chain via
 * `LegalFacet.setCurrentTos(version, hash)`; the JSX here reproduces
 * the same text verbatim so the user sees what they're signing. Any
 * edit to this text MUST be accompanied by the matching edit in the
 * `.md` file AND a governance-initiated version bump (otherwise the
 * on-chain acceptance hash will not match what the UI is rendering).
 */
export default function TermsPage() {
  return (
    <>
      <Navbar />
      <main className="container legal-page">
        <header>
          <h1>Vaipakam Terms of Service</h1>
          <div className="legal-meta">
            <span>Version 1</span>
            <span>·</span>
            <span>Effective 2026-04-24</span>
          </div>
        </header>

        <section>
          <h2>What this document is</h2>
          <p>
            These Terms govern your use of the Vaipakam protocol. Vaipakam is a
            non-custodial, on-chain peer-to-peer lending and NFT-rental
            protocol. When you connect your wallet and interact with the app at
            vaipakam.com (or any other Vaipakam-branded frontend), you are doing
            so under these Terms.
          </p>
        </section>

        <section>
          <h2>Not a service provider</h2>
          <p>
            Vaipakam is not a custodian, broker, bank, exchange, or financial
            adviser. The smart contracts run on public blockchains. You interact
            with them directly via your own wallet. The frontend at vaipakam.com
            is a convenience layer — the same smart contracts are reachable from
            any wallet and any other UI.
          </p>
        </section>

        <section>
          <h2>No advice</h2>
          <p>
            Nothing on the site or in this document is financial, legal, tax, or
            investment advice. You are responsible for evaluating the risks of
            every position you take and for your own regulatory compliance in
            whatever jurisdiction you reside in.
          </p>
        </section>

        <section>
          <h2>Risk of total loss</h2>
          <p>
            You can lose every asset you commit to a loan position, a rental
            position, or a VPFI balance. Smart contract bugs, oracle
            manipulation, liquidation cascades, bridge failures, chain
            reorganisations, and wallet compromises are all scenarios in which
            the value of an on-chain position can go to zero. Participation in
            Vaipakam implies you accept these risks.
          </p>
        </section>

        <section>
          <h2>Prohibited use</h2>
          <p>You may not use Vaipakam:</p>
          <ul>
            <li>
              from a jurisdiction where accessing a non-custodial DeFi protocol
              requires registration you haven't completed, or where
              participation is prohibited outright;
            </li>
            <li>
              if your wallet address is listed under any sanctions programme in
              force in the United States, European Union, or United Kingdom;
            </li>
            <li>
              to launder funds, finance terrorism, or otherwise violate any
              applicable law;
            </li>
            <li>
              to attack, exploit, or probe the protocol or its infrastructure.
            </li>
          </ul>
        </section>

        <section>
          <h2>Protocol changes</h2>
          <p>
            The protocol's parameters — fees, liquidation thresholds, reward
            rates, supported assets — can be changed by governance. Changes that
            could affect an active position give users a public notice window
            through the Timelock mechanism. Your active positions continue to
            follow the parameters in force when you opened them, unless
            explicitly stated otherwise for a specific change.
          </p>
        </section>

        <section>
          <h2>Keeper delegation</h2>
          <p>
            Vaipakam supports delegating "keeper" actions on your behalf to
            whitelisted addresses. A keeper you authorize can execute non-claim,
            role-scoped actions on your loans (refinance, repay, add-collateral,
            preclose). Keepers CANNOT claim funds or transfer your position NFT.
            You can enable or disable keeper access per-loan or per-offer at any
            time while the position is active. You remain responsible for any
            action a keeper you authorized takes.
          </p>
        </section>

        <section>
          <h2>Your wallet is your signature</h2>
          <p>
            The wallet address you connect IS your identity on the protocol.
            Your acceptance of these Terms is a cryptographic record anchored to
            that wallet, time-stamped by the on-chain block number. If you lose
            access to the wallet, you lose access to every position it holds —
            the Vaipakam team cannot recover any asset on your behalf.
          </p>
        </section>

        <section>
          <h2>Changes to these Terms</h2>
          <p>
            Governance can publish a new version of these Terms. When it does,
            the on-chain current-version and content-hash pair increments, and
            users must sign a new acceptance from their wallet before the
            frontend re-opens the app to them. Failure to re-sign does not
            affect your on-chain positions — the Terms gate is only a frontend
            gate, not a protocol gate.
          </p>
        </section>

        <section>
          <h2>No warranty</h2>
          <p>
            The protocol and the frontend are provided "as is" without any
            warranty of fitness, merchantability, or absence of bugs. Every
            participant — including the protocol's own developers and governance
            signers — uses Vaipakam at their own risk.
          </p>
        </section>

        <section>
          <h2>Limitation of liability</h2>
          <p>
            To the maximum extent permitted by applicable law, Vaipakam and its
            contributors are not liable for any loss arising from your use of
            the protocol or frontend.
          </p>
        </section>

        <section>
          <h2>Governing convention</h2>
          <p>
            These Terms are deliberately short and written in plain English.
            They do not substitute for professional legal advice. If your
            jurisdiction imposes specific disclosures on DeFi usage, you are
            responsible for obtaining them.
          </p>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            Security reports: via the bug bounty link in the footer.
            Non-security questions: via the public Discord link.
          </p>
        </section>
      </main>
      <Footer />
      <DiagnosticsDrawer />
    </>
  );
}
