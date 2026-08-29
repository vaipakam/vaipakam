/**
 * How long a signed erasure / status request stays valid — the
 * service rejects a signature older (or further in the future) than
 * this. Shared so the CLIENT can refuse to send a request it already
 * knows is stale (#2008 round 3 P2): the wallet prompt is unbounded,
 * and a signature approved after the window has passed would only
 * come back as a generic failure the user cannot interpret.
 */
export const ERASURE_SIGNATURE_MAX_AGE_SECONDS = 10 * 60;

/**
 * The canonical EIP-191 message a user signs to authorise erasure of
 * (or a status check on) their server-side error-diagnostics records
 * (T-075, surfaced in-app by #2002).
 *
 * ONE source of truth, by design: the wallet prompt the connected app
 * shows and the reconstruction the agent Worker recovers the signer
 * from MUST be byte-identical, or recovery yields a different address
 * and every request is rejected. The builder lived in
 * `apps/agent/src/diagErasure.ts` while no frontend consumer existed,
 * with a note to move it here the day one was built — a second
 * hand-written copy in the app is the likeliest way the feature ships
 * broken, which is exactly the drift this package's single-source
 * discipline (ABIs, contract errors) exists to prevent.
 *
 * The FORMAT IS FROZEN. It is mirrored in the PIA documentation and
 * every signature ever collected was made over this exact byte
 * sequence; the frozen-format test pins it verbatim. The wallet is
 * lower-cased so a checksummed and an all-lowercase spelling of the
 * same address produce the same message.
 *
 * @param wallet   Full EVM address (validated by the caller).
 * @param issuedAt Unix seconds the request was signed at.
 */
export function buildErasureMessage(wallet: string, issuedAt: number): string {
  return [
    'Vaipakam — Erase my error-diagnostics records',
    '',
    'I request erasure of the server-side error-capture records',
    'associated with the wallet below. Signing this message proves',
    'ownership of the wallet. It is not a transaction and costs no gas.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Issued at (unix): ${issuedAt}`,
  ].join('\n');
}

/**
 * The message signed for a STATUS check — deliberately DIFFERENT
 * wording from {@link buildErasureMessage}, so one signature can
 * never authorise the other (#2008 round 2 P1: with both endpoints
 * verifying the same bytes, every status signature was also a valid
 * erasure capability for the whole replay window — a user who asked
 * only to LOOK had signed something that could DELETE). The same
 * rule the alerts link/unlink/test messages already follow. The
 * erasure format above is untouched — it is the frozen one mirrored
 * in the PIA doc — and this one is frozen from its first release the
 * same way.
 */
export function buildErasureStatusMessage(wallet: string, issuedAt: number): string {
  return [
    'Vaipakam — Check my error-diagnostics records',
    '',
    'I request a status check on the server-side error-capture',
    'records associated with the wallet below. This request erases',
    'nothing. Signing this message proves ownership of the wallet.',
    'It is not a transaction and costs no gas.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Issued at (unix): ${issuedAt}`,
  ].join('\n');
}
