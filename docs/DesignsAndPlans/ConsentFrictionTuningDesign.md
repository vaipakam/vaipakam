# Consent-friction tuning (E-14)

**Status:** design for **legal glance → frontend change**. Card: #1216.
Umbrella: #1221. Must stay consistent with #927's consent-*reset* fixes
(reset when disclosure inputs change) — this card is the inverse: don't
re-ask when nothing changed.

## Problem

The consent surface re-asks aggressively: full risk-and-terms
acknowledgement on every create AND accept, re-confirmation on any
disclosure-driving field change, and terms-version bumps that re-lock all
prior progressive-risk consents behind a full re-affirmation wall.

## Design

### 1. Session-scoped consent memory (frontend-only)

Cache the user's acknowledgement **keyed by the disclosure-input hash**
(the same field set #927 resets on: interest mode, partial-repay, asset
types, amounts-band, risk tier), scoped to wallet + session:

- Same wallet, same session, identical disclosure hash → the checkbox
  pre-fills with a visible "acknowledged earlier this session — review"
  affordance; **the typed acceptance signature at accept-time is NEVER
  cached** (anti-phishing term binding is load-bearing and stays
  per-transaction).
- Any hash change → full re-ask (exactly #927's reset rule; one shared
  hash function so the two behaviours cannot drift).
- Session ends (disconnect/lock/24h) → cache cleared. Nothing persists to
  storage beyond the session; nothing changes on-chain consent semantics.

**Legal boundary to confirm:** pre-filling an acknowledgement checkbox
within one session for identical disclosures, vs. requiring a fresh click.
The conservative fallback (still a big win): keep the click but collapse
the full disclosure text to a summary with "unchanged since your last
acknowledgement" + expand link.

### 2. Terms-version diff view

On a terms-version bump (progressive-risk re-lock, ToS gate update):

- Show a rendered **diff against the version the user last acknowledged**
  (old/new text, changed sections highlighted), sourced from the versioned
  terms artifacts; full text one click away.
- The re-acknowledgement itself is unchanged (fresh signature over the new
  version hash) — only the *reading burden* drops.
- If the previously-acknowledged version's text is unavailable, fall back
  to the full re-affirmation wall (never show a diff against a guessed
  base).

### 3. Explicitly out of scope

Weakening: the accept-time typed statement, the on-chain consent flags,
commit-reveal terms anchors, per-pair illiquid acknowledgements, or any
on-chain re-lock semantics. This card only removes *redundant reading and
clicking*, never a legal checkpoint.

## Tests

Hash-stability unit tests shared with the #927 reset logic; session-expiry
clearing; diff-view fallback; e2e: edit a disclosure-driving field →
full re-ask; edit a cosmetic field → no re-ask. COVERAGE.md row.
