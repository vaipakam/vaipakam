import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
 * THE RENDERED TEXT IS THE HASHED BYTES (#2010 round 1 P1). Each
 * version is rendered from its frozen Markdown source in
 * `terms/v<N>.md` — a byte-copy of the canonical
 * `docs/Terms/TermsOfService.md` at the commit that published the
 * version, which is the exact document `canonicalMdKeccak256`
 * fingerprints and governance hashes for
 * `LegalFacet.setCurrentTos(version, hash)`. A hand-maintained JSX
 * transcription was tried first and had ALREADY drifted from the
 * canonical text it claimed to mirror; rendering the source itself
 * removes the transcription step entirely, and
 * `scripts/check-terms-canonical-hash.ts` pins every frozen file to
 * its registry hash (and the current one to the canonical doc).
 *
 * Publishing a NEW version means: freeze the new canonical text as
 * `terms/v<N>.md` + add the `versions.ts` entry + the governance
 * version bump — never an edit to a published file. The glob below
 * picks up every `v*.md` automatically, so a registry entry cannot
 * be left without its text by a forgotten import (#2010 round 1 P2);
 * a registry/file mismatch fails the guard script, and the runtime
 * fallback renders the not-published explainer rather than crashing.
 *
 * Version-pinned routes carry `robots: noindex` (#2010 round 1 P2):
 * they are archives duplicating `/terms`'s content, and staying out
 * of the sitemap alone does not stop a crawler that follows the
 * version-index links from indexing self-canonicalizing duplicates.
 */

const TERMS_SOURCES = import.meta.glob("./terms/v*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function termsSource(version: number): string | undefined {
  return TERMS_SOURCES[`./terms/v${version}.md`];
}

/** The canonical-source fingerprint shown under a version's text.
 *  The Markdown itself carries the document's own title/version
 *  header; this line adds the one thing the document cannot say
 *  about itself — the fingerprint a reader can compare against the
 *  content hash the acceptance gate displays from chain, once
 *  governance records that derivation for `setCurrentTos`. */
function VersionMeta({ version }: { version: number }) {
  const meta = termsVersionMeta(version);
  if (!meta) return null;
  return (
    <p className="legal-meta legal-meta-hash">
      Canonical source fingerprint (keccak256 of this version's Markdown
      source): <code>{meta.canonicalMdKeccak256}</code>
    </p>
  );
}

/** Links to every published version, shown at the foot of the page
 *  so old acceptances stay one click from their text. `relative`
 *  path links keep the active locale prefix. "Latest published" —
 *  deliberately NOT "current" (#2010 round 1 P2): during a rollout
 *  the chain's in-force version lags the latest published one, and
 *  this page cannot see the chain. */
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
            {m.version === CURRENT_TERMS_VERSION ? " (latest published)" : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function TermsPage() {
  const { versionSlug } = useParams<{ versionSlug?: string }>();
  const pinned = versionSlug !== undefined;
  usePageMeta({
    titleKey: "pageMeta.terms.title",
    descriptionKey: "pageMeta.terms.description",
    // Pinned archives duplicate /terms's content and must not be
    // indexed as independent pages; /terms itself stays indexable.
    robots: pinned ? "noindex" : undefined,
  });

  const requested = pinned
    ? parseTermsVersionSlug(versionSlug)
    : CURRENT_TERMS_VERSION;
  const meta = requested === null ? null : termsVersionMeta(requested);
  const source = meta ? termsSource(meta.version) : undefined;

  if (!meta || source === undefined) {
    // Unknown slug, or a version the chain may already name but this
    // deploy does not serve yet. An honest page beats a silent 404:
    // the reader learns exactly which versions exist here and where
    // the latest one is.
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
              {pinned && parseTermsVersionSlug(versionSlug) !== null
                ? "This site does not (yet) serve the Terms version this link names. " +
                  "If the app's acceptance prompt sent you here, the text for that " +
                  "version has not been published at its pinned address yet — " +
                  "please do not accept until you can read the exact version the " +
                  "prompt names."
                : "This address does not name a published Terms version."}{" "}
              The versions this site serves are listed below.
            </p>
          </section>
          <VersionIndex fromPinned={pinned} />
        </main>
        <Footer />
      </>
    );
  }

  // "Newer published", never "superseded in force" (#2010 round 1
  // P2): during the runbook's mandated rollout window the latest
  // PUBLISHED version is ahead of the version IN FORCE on chain, and
  // this pinned page may be exactly the text a pending acceptance
  // records. The banner therefore states only what this site can
  // know — publication order — and defers "which version applies to
  // you" to the acceptance prompt.
  const newerPublished = meta.version !== CURRENT_TERMS_VERSION;

  return (
    <>
      <Navbar />
      <main className="container legal-page">
        <EnglishOnlyNotice />
        {newerPublished ? (
          <div className="legal-superseded-banner" role="note">
            A newer version of these Terms has been published. Version{" "}
            {meta.version} is kept unchanged at this address because
            acceptances are recorded against specific versions — if the
            app's acceptance prompt names version {meta.version}, this is
            the exact text it records.{" "}
            <Link to=".." relative="path">
              Read the latest published version
            </Link>
            .
          </div>
        ) : null}

        {/* The frozen Markdown source, rendered as-is — the bytes on
            screen are the bytes the fingerprint below covers. */}
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>

        <VersionMeta version={meta.version} />

        <VersionIndex fromPinned={pinned} />
      </main>
      <Footer />
    </>
  );
}
