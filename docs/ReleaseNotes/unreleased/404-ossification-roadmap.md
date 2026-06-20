### #404 — Published ossification roadmap + guardian-pause framing

Vaipakam now publishes an **ossification roadmap** (`docs/DesignsAndPlans/OssificationRoadmap.md`)
— a plain-English, honest commitment about which protocol rules can still
change, who can change them, and behind what delay. It does **not** claim an
immutable core (the protocol is fully upgradeable today, on purpose, pre-audit);
instead it commits to a staged, milestone-gated freeze and frames the guardian
guarantee around primitives that already exist.

What it tells a reader:

- **The guardian fast-pause already exists.** The asymmetric `PAUSER` (fast
  pause, guardian Safe) / `UNPAUSER` (slow unpause, timelock) split is the
  guardian-pause the design called for — no new role invented.
- **Staged freeze, ordered by trust.** Fund-custody + core accounting freeze
  first; curation parameters stay bounded-upgradeable. The freeze is
  milestone-gated (audit sign-off → published mainnet bake → renounce), with no
  calendar dates committed before the audit.
- **Honest gaps, named not hidden.** The document explicitly discloses where the
  current guarantees rest on multisig honesty rather than code — the root
  `DEFAULT_ADMIN`/`ADMIN` timelock-bypass (role-grant + `transferAdmin`), the
  arbitrary-address oracle / rate-model / executor-pointer setters, the
  per-notification fee debit that sits outside the timelock, and every
  cross-chain and UUPS upgrade surface that must be frozen alongside the Diamond
  cut path.

Two hardening follow-ups were filed from the review: reconciling the legacy
handover script so it can't leave the unpause key on a hot wallet (#650), and a
code-derived census so the freeze/allowlist scope provably covers every
custody-moving surface (#651).

No contract behaviour changed — this is a published commitment and an accurate
trust-surface map.
