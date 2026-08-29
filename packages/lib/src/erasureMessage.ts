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
