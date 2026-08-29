import type { ComponentType } from "react";
import { Link, useParams } from "react-router-dom";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import { EnglishOnlyNotice } from "../components/EnglishOnlyNotice";
import { usePageMeta } from "../lib/usePageMeta";
import {
  CURRENT_TERMS_VERSION,
  TERMS_VERSION_METAS,
  parseTermsVersionSlug,
  termsVersionMeta,
} from "./terms/versions";
import { TermsV1Body } from "./terms/TermsV1Body";
import "./LegalPage.css";

/**
 * Public Terms of Service page — VERSIONED hosting (#1998).
 *
 * The connected app's acceptance gate records a wallet's acceptance
 * against a specific on-chain (version, content-hash) pair, and links
 * the user to `/terms/v<version>` — the version its hash actually
 * pins. This page serves:
 *
 * - `/terms` — the CURRENT version (the last `versions.ts` entry);
 * - `/terms/v<N>` — version N, frozen forever, so an acceptance
 *   recorded years ago still resolves to the text that was accepted,
 *   and the rollout window (new page published before
 *   `setCurrentTos` executes) can no longer show one text while the
 *   gate records another;
 * - `/terms/<anything else>` — an honest "not published here"
 *   explainer instead of a silent 404, covering a gate that links a
 *   version this deploy does not serve yet (the wrong-order rollout
 *   case) as well as mistyped links.
 *
 * Each version's body is a frozen component (`terms/TermsV<N>Body`);
 * the text rendered here mirrors the canonical
 * `docs/Terms/TermsOfService.md` at the commit that published the
 * version — the source governance hashes and pins on-chain via
 * `LegalFacet.setCurrentTos(version, hash)`. Publishing a NEW version
 * means: new body file + new `versions.ts` entry (this page maps it
 * below) + the canonical `.md` update + a governance version bump —
 * never an edit to a published body.
 */

/** version → frozen body component. Must stay exhaustive over
 *  `versions.ts` (the hash guard script cross-checks the two lists);
 *  if an entry ever lacked a mapping, the fallback below renders the
 *  not-published explainer rather than crashing. */
const TERMS_BODIES: Record<number, ComponentType> = {
  1: TermsV1Body,
};

/** The version metadata line + canonical-source fingerprint shown
 *  under every version's title. The fingerprint is the keccak256 of
 *  the version's canonical Markdown source — published so a user (or
 *  a script) can compare what this page claims against the content
 *  hash the acceptance gate displays from chain, once governance
 *  records that derivation for `setCurrentTos`. */
function VersionMeta({ version }: { version: number }) {
  const meta = termsVersionMeta(version);
  if (!meta) return null;
  return (
    <>
      <div className="legal-meta">
        <span>Version {meta.version}</span>
        <span>·</span>
        <span>Effective {meta.effective}</span>
        {version === CURRENT_TERMS_VERSION ? (
          <>
            <span>·</span>
            <span>Current</span>
          </>
        ) : null}
      </div>
      <p className="legal-meta legal-meta-hash">
        Canonical source fingerprint (keccak256 of this version's
        Markdown source):{" "}
        <code>{meta.canonicalMdKeccak256}</code>
      </p>
    </>
  );
}

/** Links to every published version, shown at the foot of the page
 *  so old acceptances stay one click from their text. `relative`
 *  path links keep the active locale prefix. */
function VersionIndex({ fromPinned }: { fromPinned: boolean }) {
  return (
    <section>
      <h2>All published versions</h2>
      <ul>
        {TERMS_VERSION_METAS.map((m) => (
          <li key={m.version}>
            <Link
              to={fromPinned ? `../v${m.version}` : `v${m.version}`}
              relative="path"
            >
              Version {m.version}
            </Link>{" "}
            — effective {m.effective}
            {m.version === CURRENT_TERMS_VERSION ? " (current)" : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function TermsPage() {
  usePageMeta({
    titleKey: "pageMeta.terms.title",
    descriptionKey: "pageMeta.terms.description",
  });
  const { versionSlug } = useParams<{ versionSlug?: string }>();

  const requested =
    versionSlug === undefined ? CURRENT_TERMS_VERSION : parseTermsVersionSlug(versionSlug);
  const meta = requested === null ? null : termsVersionMeta(requested);
  const Body = meta ? TERMS_BODIES[meta.version] : undefined;

  if (!meta || !Body) {
    // Unknown slug, or a version the chain may already name but this
    // deploy does not serve yet. An honest page beats a silent 404:
    // the reader learns exactly which versions exist here and where
    // the current one is.
    return (
      <>
        <Navbar />
        <main className="container legal-page">
          <EnglishOnlyNotice />
          <header>
            <h1>Vaipakam Terms of Service</h1>
          </header>
          <section>
            <h2>This version is not published here</h2>
            <p>
              {versionSlug !== undefined && parseTermsVersionSlug(versionSlug) !== null
                ? "This site does not (yet) serve the Terms version this link names. " +
                  "If the app's acceptance prompt sent you here, the text for that " +
                  "version has not been published at its pinned address yet — " +
                  "please do not accept until you can read the exact version the " +
                  "prompt names."
                : "This address does not name a published Terms version."}{" "}
              The versions this site serves are listed below.
            </p>
          </section>
          <VersionIndex fromPinned />
        </main>
        <Footer />
      </>
    );
  }

  const superseded = meta.version !== CURRENT_TERMS_VERSION;

  return (
    <>
      <Navbar />
      <main className="container legal-page">
        <EnglishOnlyNotice />
        {superseded ? (
          <div className="legal-superseded-banner" role="note">
            You are reading Terms version {meta.version}, which has been
            superseded. It is kept unchanged at this address because
            acceptances were recorded against it.{" "}
            <Link to=".." relative="path">
              Read the current version
            </Link>
            .
          </div>
        ) : null}
        <header>
          <h1>Vaipakam Terms of Service</h1>
          <VersionMeta version={meta.version} />
        </header>

        <Body />

        <VersionIndex fromPinned={versionSlug !== undefined} />
      </main>
      <Footer />
    </>
  );
}
