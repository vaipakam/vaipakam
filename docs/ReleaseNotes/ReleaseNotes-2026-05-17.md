# Release Notes — 2026-05-17

A broad day of off-chain and operational hardening — five independent
threads merged to `main`. None touched the on-chain contracts; the work
spans pre-sign transaction safety, secret management, a privacy
right-to-erasure mechanism, a dependency-modularity audit, and a small
storage rename.

## Thread 1 — ET-001: pre-sign transaction preview via `eth_call` (PR #41)

The pre-sign transaction-preview surface in the DeFi app was reworked
from an external-vendor scanner into a pure in-app simulation. When a
user is about to sign a transaction, the app now simulates the pending
calldata directly against the chain (an `eth_call` preflight) and shows
one of three advisory verdicts in a subdued footer — "simulated OK",
"would revert, with the reason", or "unavailable". The preview is purely
advisory and never blocks signing.

This thread went through two abandoned vendor integrations before
settling. It began as a Blockaid transaction scanner, switched to GoPlus,
and finally dropped third-party scanners entirely. Live testing was
decisive: a pre-sign scan of a transaction against Vaipakam's *own
audited Diamond* is a correctness aid — "will this revert before I spend
gas" — not a threat shield, so a security-vendor scanner was the wrong
tool. GoPlus's decoded-parameter output proved unreliable, and its
simulation endpoint is mainnet-only and rate-limited on the free tier —
meaning it would cover none of Vaipakam's current testnet activity. An
`eth_call` preflight works on every chain, for free, with no vendor, no
API key, and no Worker proxy.

The agent Worker accordingly lost its whole transaction-scan surface —
the GoPlus client, the scan proxy route, and the associated secrets and
feature flags. A review-driven fix removed a false-"safe" verdict that
could flash before a real result arrived, and a placeholder Permit2
signature revert on the accept-with-permit path is now recognised as a
preview artefact and shown as "unavailable" rather than a failure. GoPlus
is not gone from the platform — it moves to third-party asset and
counterparty risk scanning (token / NFT / address / approval checks),
which is mainnet-centric and tracked on its own cards. Closes #32.

## Thread 2 — T-075: user-initiated erasure of server-side error records (PR #29)

T-075 builds a GDPR Article-17-style right-to-erasure mechanism for the
server-side error records — the diagnostic-error table the agent Worker
writes when the app reports a client error. It is the follow-up to the
Privacy Policy v2 work, which committed the protocol to providing an
erasure path. Three new endpoints are added: a user can delete their own
error records (authenticated by a wallet signature), query the erasure
status, and — for an admin — place or lift a legal hold.

Three problems shaped the design. First, the deletion identity: the
error rows store only a *redacted* wallet address, which is non-unique,
so deleting by it could erase unrelated users' rows. The real key is a
keyed hash of the full address (a per-wallet HMAC) — unique, and unlike a
plain hash of a public address space, not reversible from a database
dump. The hash is computed transiently at capture time; the full address
is never stored. Second, gag-order safety: the erasure endpoint never
branches its response — a wallet under a legal hold gets a byte-identical
reply to one with no hold (enforced by a test) — and any "retained by
law" disclosure is a separate, explicitly admin-gated action that is off
by default. Third, legal-hold authorisation uses no shared secret: the
admin signer must hold the on-chain `ADMIN_ROLE`, making the contract's
access-control state the source of truth, and placing a hold requires
uploading the authorising order document, which the Worker hashes,
verifies, and files in a private store with an append-only audit trail.

A test harness was added to the agent Worker (it had none) with 34 cases
covering the keyed-hash properties, signature verification, the
uniform-response invariant, and legal-hold document verification. The
feature ships **inert** — every endpoint returns an unavailable status
until the secrets, the document store, and an admin wallet exist — so the
PR alone changes no production behaviour; the live deploy is gated on a
privacy-lawyer sign-off. Deferred to follow-ups: the admin legal-hold
panel, the user-facing "erase my records" UI, and an optional
document-retrieval endpoint. Closes #28.

## Thread 3 — T-078: all Worker secrets moved to Cloudflare Secrets Store (PR #36)

Every Cloudflare Worker secret was migrated from per-Worker storage to
the account-level Cloudflare Secrets Store. A shared secret is now
defined once and bound into each Worker that needs it — giving
single-point rotation for values that were previously duplicated across
Workers (the per-chain RPC URLs, the Telegram bot token, the swap-
aggregator keys, and the push-channel signing key). The migration landed
in three phases — the indexer, then the keeper, then the agent Worker.

Secrets Store bindings are read asynchronously rather than as plain
strings. Rather than thread that through every call site, each Worker
now resolves all of its secrets exactly once at its entry point — a
single step awaits every fetch in parallel and produces a fully-resolved
plain configuration object — so all downstream code stays synchronous.
The decision was made to move *all* secrets into the store, including the
keeper and push-channel signing keys, accepting that Secrets Store is
currently an open beta, in exchange for one consistent mechanism with
central management, an audit log, and single-point rotation. Non-secret
configuration was deliberately left as plain Worker config.

This PR wires bindings and code only — it does not provision secret
values; before deploy the operator must create each secret in the store.
A late hardening commit made the resolve step resilient to a
secret-fetch failure and dropped the now-unused Blockaid key binding
(ET-001 was concurrently removing the Blockaid scanner). Closes #31.

## Thread 4 — T-081: third-party dependency modularity audit (PR #35)

A documentation thread: a verified audit of every third-party dependency
Vaipakam relies on — on-chain and off-chain — each graded for how easily
it could be swapped for an alternative. The grades are config-swappable
(replaceable at runtime via an admin setter, no code change), code-
swappable (a localized one-file change), or deep-integrated (pervasive,
a major effort to replace).

The result: 9 dependencies config-swappable, 9 code-swappable, and only
2 deep-integrated. Every safety-critical on-chain dependency — the swap
aggregators, the whole oracle layer, the sanctions oracle — is
admin-config-swappable with no contract upgrade. Off-chain providers are
each isolated behind a single-file proxy, making them a localized code
swap (the concurrent ET-001 vendor migration is cited as live proof).
The only two deep-integrated dependencies are LayerZero (cross-chain
messaging, replacement tracked as T-068 — now in progress) and Cloudflare
(the entire off-chain host, resilience tracked as T-077); both are
inherent to their roles and both already on the tracker. The audit's
verdict: the platform is well-modularized for provider-swapping and no
structural change is needed. The audit also corrected a stale assumption
from an earlier from-memory note — the Pyth oracle is in fact present (a
numeraire cross-check), having only been dropped from the secondary
price quorum, not the platform. Closes #34.

## Thread 5 — ET-018: legal-document store renamed (PR #45)

A small rename. The agent Worker's private store for legal-hold order
documents (introduced by T-075) was renamed from `vaipakam-legal-docs` to
`vaipakam-legal-vault` — "vault" better conveys its role as a secured,
restricted-access store. Only the storage binding's target name changed;
the code-facing identifier is unchanged, so no application code was
touched. The operator still needs to redeploy the agent Worker against
the new store and remove the old one once confirmed empty. Closes #44.

## Operational

- **No on-chain behaviour change** from any thread today — all five are
  off-chain (Workers, frontend) or documentation.
- **T-075 and T-078 both ship gated.** T-075's endpoints stay inert
  until their secrets / store / admin wallet exist and a privacy-lawyer
  signs off; T-078 wires secret *bindings* but the operator must still
  create the secret *values* in the store before deploy.
- **ET-001** removed the agent Worker's transaction-scan surface
  entirely — operators can drop the corresponding secrets and feature
  flags from the Worker configuration.
