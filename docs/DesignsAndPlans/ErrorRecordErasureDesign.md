# Error-Record Erasure — Design (T-075)

**Status:** built, test-covered; **deploy gated on a crypto/privacy-lawyer
sign-off** (mirrors T-600's Track-2 gating).
**Issue:** [#28](https://github.com/vaipakam/vaipakam/issues/28).
**Follows from:** T-074 / [#27](https://github.com/vaipakam/vaipakam/issues/27)
(Privacy Policy v2 — server-side error capture), which committed the
protocol to an erasure path. This builds the mechanism.
**Companion:** `docs/DesignsAndPlans/PIA-2026-05-16-server-side-error-capture.md`
(introduced by PR #26).

## 1. Goal

A GDPR Art-17-style **right-to-erasure** path for the server-side
error records — the `diag_errors` D1 table written by the
error-capture endpoint (`POST /diag/record`) on the `apps/agent`
Cloudflare Worker. A user can have their own error records erased on
demand, without a support ticket.

## 2. Confirmed decisions (founder, 2026-05-17)

| # | Decision | Choice |
| --- | --- | --- |
| D1 | Erasure path | **Automated self-service, primary; support an edge-case fallback.** A user signs an erasure-request message with their wallet; the Worker verifies it and deletes their records. |
| D2 | Deletion identity | **Server-side keyed hash** — `HMAC-SHA256(fullWallet, DIAG_WALLET_HMAC_KEY)`. The stored redacted wallet (`0x…abcd`) is non-unique and cannot be a deletion key. |
| D3 | Blocked-deletion response | **Uniform by default**, with an opt-in per-wallet disclosure flag (D3a below). |
| D3a | Disclosure flag | A per-wallet-hash `disclosure_allowed` flag, **default false**, admin-settable. False → the status endpoint stays generic (gag-safe). True → it may surface a "retained by law" note. The flag only ever moves toward more disclosure, by a deliberate human action. |

## 3. Why a keyed hash (D2 in depth)

`diag_errors` rows store a **redacted** wallet (`0x…abcd`) for triage
display. That value is **not unique** — two distinct wallets that
share the same leading/trailing nibbles collapse to one string.
Deleting by it would erase an unrelated user's records on a
collision, so it cannot identify "this user's records".

The real deletion key is a **server-side keyed hash**:

```
wallet_hash = HMAC-SHA256( lowercased_full_wallet, DIAG_WALLET_HMAC_KEY )
```

- **Unique per wallet** — no collisions.
- **Not reversible without the server key.** A plain `SHA-256` of an
  address would be trivially rainbow-tabled — the set of addresses
  that have ever transacted is public and finite. The keyed HMAC
  defeats that: a D1 dump alone cannot map a `wallet_hash` back to an
  address.
- **Stable** — an erasure request recomputes the identical hash from
  a freshly signed wallet, matching every stored row.

The hash **must** be computed server-side: the HMAC key cannot ship
in the browser bundle (a public key collapses the HMAC to an
unkeyed, reversible hash). This is why the capture path now sends the
**full** wallet to the Worker. The Worker uses it transiently — HMACs
it in memory, stores only `wallet_hash` + the redacted display, and
**never persists the full address**.

## 4. Architecture

### 4.1 Schema — `apps/indexer/migrations/0013_diag_erasure.sql`

- `diag_errors.wallet_hash TEXT` — the deletion key (NULL for rows
  captured before this migration and for not-connected sessions).
  Indexed (`idx_diag_errors_wallet_hash`).
- `diag_legal_holds` — admin-only legal-hold register, keyed by
  `wallet_hash`: `hold_reason` (free-text human label),
  `disclosure_allowed` (default 0), `disclosure_note`,
  `legal_doc_ref` + `legal_doc_sha256` (the legal document backing
  the current hold — see §4.5), `created_at`, `updated_at`.
- `diag_legal_hold_audit` — append-only trail; one row per
  place / lift / set-disclosure action: `at`, `action`,
  `wallet_hash`, `admin_wallet` (the signing admin), `detail`,
  `legal_doc_ref` + `legal_doc_sha256` (the document authorising
  *that* action). No code path ever updates or deletes from it.

All additions are additive — no column rewrite, safe to apply ahead
of the endpoints shipping.

### 4.2 Capture-path change — `apps/agent/src/diagRecord.ts` + `apps/defi/src/lib/journeyLog.ts`

The frontend's `/diag/record` payload gains a `wallet` field — the
**full** connected address (null when not connected). The Worker, in
`diagRecord.ts`, derives `wallet_hash` from it via the new
`diagHash.ts` helper and stores the hash; the full address is
discarded. When `wallet` is absent, `wallet_hash` stays NULL — that
not-connected row simply isn't reachable by automated erasure
(support remains the fallback). For connected-wallet records,
`DIAG_WALLET_HMAC_KEY` is a production prerequisite and is now
provisioned; deployment should not run wallet-keyed capture without
it.

### 4.3 Endpoints — `apps/agent/src/diagErasure.ts`

| Endpoint | Auth | Behaviour |
| --- | --- | --- |
| `POST /diag/erasure` | EIP-191 wallet signature | Verifies the signature, computes `wallet_hash`, and — unless a legal hold exists — deletes every `diag_errors` row for that hash. **Always** returns the uniform `{status:'processed'}`. |
| `POST /diag/erasure/status` | EIP-191 wallet signature | Returns `{status:'processed'}` UNLESS a hold exists with `disclosure_allowed = 1`, in which case `{status:'retained_by_law', note}`. |
| `POST /diag/legal-hold` | Admin wallet signature → on-chain `ADMIN_ROLE` | Protocol-admin only: `place` / `lift` a hold, or `set-disclosure` to toggle the per-wallet flag. A `place` is `multipart/form-data` and **must** carry the authorising document (§4.5). Every action is appended to `diag_legal_hold_audit`. |

**Signature scheme.** No accounts — wallet ownership is proven by an
EIP-191 `personal_sign` over a fixed, human-readable message (see
`buildErasureMessage`) naming the wallet and an `issuedAt` unix
timestamp. The Worker reconstructs the exact message, recovers the
signer (viem `recoverMessageAddress`), and requires it to equal the
claimed wallet. `issuedAt` must be within a 10-minute window. The
signature is not a transaction and costs no gas.

**Legal-hold admin auth (no shared secret).** `/diag/legal-hold`
uses the *same* signed-request mechanism, but the bound message is
`buildLegalHoldMessage` (it covers the action, target wallet,
reason, disclosure fields, the uploaded document's SHA-256, and the
timestamp, so a signature can't be lifted onto a different action or
a different document). Authorization is **on-chain**: the
Worker recovers the signer and requires it to hold `ADMIN_ROLE` on
the Vaipakam Diamond (`diagAdminAuth.ts` → `AccessControlFacet.hasRole`
— the exact check `apps/defi`'s protocol console runs). There is no
`DIAG_ADMIN_TOKEN` or any other admin secret in the Worker's env —
the contract's access-control state is the single source of truth
for "who is an admin". The endpoint is naturally inert before
deploy: with no RPC / deployment configured, the on-chain check
finds no admin and every call is 403.

> When the frontend erasure UI is built (see §8), `buildErasureMessage`
> should move to `packages/lib` so frontend + Worker import one
> source of truth — the same single-source discipline the repo
> applies to ABIs. Until then the format is frozen in `diagErasure.ts`
> and reproduced in §6.

### 4.4 The two gag-order-safe invariants

1. **The erasure endpoint never branches its response.** Same uniform
   `{status:'processed'}` whether it deleted 100 rows, 0 rows, or
   skipped everything under a hold. The response cannot tip off a
   user that their records are under a (possibly gagged) order.
   *Covered by a load-bearing test* — the held-case response is
   asserted byte-identical to the no-hold case.
2. **Disclosure is a separate, explicitly-gated action.** The status
   endpoint surfaces a "retained by law" note only when an operator
   has set `disclosure_allowed = 1`. By default — and for every
   gagged hold — it returns the same payload as a user with no hold
   at all. A malformed request (bad signature, stale timestamp) does
   get a distinct 4xx; that reveals nothing about retention.

### 4.5 Legal-document provenance — mandatory upload

Every legal hold maps to the actual legal instrument that authorised
it. `hold_reason` stays a free-text human label ("court order
2026-XYZ"); on top of it the **document itself is uploaded** when the
hold is placed. Two fields record it, on both the hold and each
audit action:

- `legal_doc_sha256` — the SHA-256 of the document. This is the
  document's content identity and the legally meaningful pin of
  *which exact order* was acted on.
- `legal_doc_ref` — the locator of the stored copy. **Worker-assigned**
  (not admin-typed): the R2 object key, content-addressed as
  `legal-holds/<sha256>.pdf`.

**The upload flow** (`diagLegalDoc.ts` is the Worker-side receiver):

1. The protocol admin, in the `apps/defi` protocol console, selects
   the PDF (e-signed order / scanned letter). The browser computes
   its SHA-256 locally and folds it into the message the admin
   signs (`buildLegalHoldMessage` carries the *hash*, not the
   locator — the locator does not exist until the Worker files the
   document, so it can't be pre-signed).
2. The console POSTs `multipart/form-data` to `/diag/legal-hold`: a
   `payload` part (the signed JSON) and a `document` part (the PDF).
3. The Worker validates the PDF (non-empty, ≤ 15 MB, `%PDF-` magic),
   computes the SHA-256 **server-side over the received bytes**, and
   requires it to equal the `legalDocSha256` the admin signed — so
   the upload is cryptographically bound to the signature ("sign
   hash X, upload file Y" is rejected `400 document_hash_mismatch`).
4. The Worker stores the PDF in the private `DIAG_LEGAL_DOCS` R2
   bucket under `legal-holds/<sha256>.pdf` (content-addressed →
   idempotent) and records `legal_doc_ref` + `legal_doc_sha256` on
   the hold and the audit row.
5. The response echoes `{legalDocRef, legalDocSha256}` so the
   console shows the admin what was filed.

**Mandatory:** a `place` with no `document` part is rejected
`400 document_required` — no hold without its authorising document
on file. `lift` / `set-disclosure` may carry a document (e.g. a
release letter) but don't have to.

The PDF lives only in the **private** R2 bucket — never a public URL;
a retention order must not sit at a world-readable address. The
Worker computes the hash itself, so the stored `legal_doc_sha256`
provably matches the stored bytes; the browser-computed hash is only
ever *compared* against it, never trusted as the recorded value.

## 5. Operator runbook — legal holds

Provision on `apps/agent`:

- `DIAG_WALLET_HMAC_KEY` (secret, `wrangler secret put`) — a
  high-entropy random string. **Rotating it invalidates every
  existing `wallet_hash`** (old rows become unerasable by the
  automated path) — treat as long-lived.
- `DIAG_LEGAL_DOCS` (R2 bucket) — `wrangler r2 bucket create
  vaipakam-legal-docs`, already wired in `wrangler.jsonc`. Private
  by default; comfortably within R2's free tier (legal documents
  are small and rare). No access keys in env — the Worker reaches
  the bucket through the binding.

There is no admin token. The legal-hold endpoint authorises by the
caller's on-chain `ADMIN_ROLE`, so the only prerequisites are that
`apps/agent` has its `RPC_*` + deployment config (it already does,
for the other crons) and that the admin's wallet holds `ADMIN_ROLE`.

When a valid retention obligation lands for a wallet (from a court /
regulator order — the order names the **address**), the admin acts
from the `apps/defi` protocol console: connect the admin wallet,
choose the action, **upload the order PDF** (for a `place`), and sign
the prompted `buildLegalHoldMessage` message. The console POSTs the
signed request to `/diag/legal-hold`; the Worker verifies the signer
holds `ADMIN_ROLE`, files the document, and appends the action to
`diag_legal_hold_audit`.

The three actions:

- **place** — `{action, wallet, holdReason, legalDocSha256}` +
  the PDF, sent as `multipart/form-data`. Erasure now skips this
  wallet's records. `holdReason` is the human label; the uploaded
  document is hashed + filed by the Worker, which auto-fills
  `legal_doc_ref` + `legal_doc_sha256` (§4.5). **The document is
  mandatory** — a `place` without it is rejected.
- **set-disclosure** — `{action, wallet, disclosureAllowed,
  disclosureNote?}` — flip the per-wallet disclosure flag. Do this
  **only** if disclosure is lawful (e.g. GDPR Art-12(4), no gag). May
  also carry a document.
- **lift** — `{action, wallet}` — remove the hold when the
  obligation ends; may carry a release-letter document.

(Until the protocol-console UI for this lands — a follow-up, §8 —
the same signed request can be produced with any EIP-191 signer
controlled by an `ADMIN_ROLE` wallet, posting the multipart form
directly.)

**Gagged holds:** place the hold and leave `disclosure_allowed`
false. The status endpoint then treats the wallet exactly like an
un-held one. Any lawful disclosure happens deliberately out-of-band,
never through endpoint logic.

**Audit trail.** Every place / lift / set-disclosure writes one
immutable row to `diag_legal_hold_audit` (which admin, when, what) —
the defensible record that the protocol acted on a genuine order.

## 6. Privacy Policy + PIA update

The Privacy Policy v2 and companion PIA now describe the T-075
self-service erasure path directly:

- users erase wallet-keyed `diag_errors` records by signing an
  erasure request with the same wallet;
- the Worker stores a one-way keyed wallet hash so rows can be
  matched without persisting the full wallet address;
- legal-hold records are skipped by the erasure endpoint; and
- disclosure of retained records is handled only through the
  separate signed status endpoint when an operator has explicitly
  enabled disclosure for that wallet.

## 7. Deploy gate

The mechanics are built and test-covered now. `DIAG_WALLET_HMAC_KEY`
has been provisioned, so connected-wallet error records can receive
their erasure key at capture time. The **deploy** of the erasure +
legal-hold endpoints remains gated on a crypto/privacy-lawyer
sign-off — valid retention obligations, gag-order handling, Art-17
exemptions, and the keyed-hash data-minimisation rationale. The
legal-hold endpoint also remains inert until an `ADMIN_ROLE` wallet
authorises an action. The frontend `recordFailureToServer` already
gates on `VITE_DIAG_RECORD_ENABLED`.

## 8. Follow-ups (not in this change)

- **Frontend erasure UI** — a "Erase my diagnostics records" action
  (likely in the Diagnostics Drawer / Privacy settings) that prompts
  the wallet signature and calls the endpoint. Move
  `buildErasureMessage` to `packages/lib` at that point.
- **Protocol-console legal-hold UI** — a panel in the `apps/defi`
  protocol console (admin-only, behind `useIsProtocolAdmin`) for the
  place / lift / set-disclosure actions: a file picker for the order
  PDF, client-side SHA-256, the wallet-sign step, the multipart POST
  to `/diag/legal-hold`, and showing the returned `legalDocRef` /
  `legalDocSha256`. The Worker side (this change) is the foundation;
  this panel is the paired next task. Move `buildLegalHoldMessage`
  to `packages/lib` alongside `buildErasureMessage` at that point.
- **Per-record hold granularity** — holds are currently per
  wallet-hash (all of a wallet's records). Finer granularity, if a
  real order ever needs it, is a later change.
- **Legal-document retrieval / viewing page** — there is currently
  no endpoint to read a stored PDF back; the operator retrieves it
  from the R2 bucket directly (Cloudflare dashboard / API). An
  admin-only, signed `GET` plus an in-console viewing page is
  tracked as **T-076**, which also covers the broader
  operator-vs-admin console split (which knobs/flags are public, a
  separate operator console / EOA, etc.). The viewing page must use
  the `ADMIN_ROLE` check — never the `DIAG_WALLET_HMAC_KEY`.
