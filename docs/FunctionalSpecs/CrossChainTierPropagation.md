# Cross-Chain VPFI Tier Propagation

T-087 Sub 2.A–D. Code-free description of how a user's earned VPFI discount tier travels from Base (the canonical chain that owns the accumulator state) to every mirror chain.

## Roles

- **Canonical chain (Base)** — the chain where users stake VPFI, where the ring-buffer accumulator lives, where the tier-table version is governed. Every per-user effective tier is computed here from observed history.
- **Mirror chain (Sepolia, Arbitrum, Optimism, BNB, etc.)** — any chain other than Base. Mirrors don't run the accumulator; they hold a tier *cache* per user that the canonical chain populates by cross-chain message.
- **Bridge (Chainlink CCIP)** — the transport carrying canonical-side tier updates to mirrors. Vaipakam holds no opinion about routes — CCIP's committing DON, executing DON, and Risk Management Network do the security work.

## Intended behaviour

### 1. A user's tier is decided on Base

Every fee-relevant operation that consults a user's tier looks at a single source of truth:

- **On Base:** the accumulator returns the user's *current* EFFECTIVE_TIER + EFFECTIVE_BPS — past the min-history elapsed-time gate and past the min-tier-over-history clamp.
- **On a mirror:** the local fee path reads the *cached* tier the canonical chain most recently sent. It applies four freshness gates (effective tier non-zero, tier-table version match, projected expiry, cache max-age). If any gate fails, the mirror treats the user as tier 0.

### 2. The canonical chain broadcasts on every nonce-bumping mutation

A "nonce-bumping mutation" is any rollup pass on Base that produces a *new* push tuple for the user — meaning the resolved `(effectiveTier, effectiveBps, tierExpirySec, tierTableVersion)` differs from the last pushed values. Examples:

- A stake or unstake that crosses a tier threshold.
- A stake or unstake within the same tier whose projected expiry moves.
- A governance-induced tier-table version bump.

When the tuple is *identical* to the last push, the broadcast is skipped — burning protocol-funded CCIP gas to push what's already there would be wasteful and would offer an attacker a way to drain the broadcast budget by repeatedly hitting the rollup with no-op mutations.

When the tuple matches `(0, 0, *, *)` *and* the user has never been pushed before, the broadcast is also skipped — mirrors' default empty cache already reads as tier 0 and there's no value in a fresh-user zero-tier push.

### 3. The mirror cache writer applies trust + ordering rules

When a mirror receives a tier-update message:

- The message must originate from Base. Messages claiming to originate from any other chain id are rejected.
- The sender must be the configured authorised CCIP messenger. CCIP's own peer authentication is honoured; an additional Diamond-side check confirms the channel peer is the registered Base messenger.
- The message's nonce must be strictly greater than the last nonce the mirror saw for the same user. Stale / replayed / out-of-order messages are rejected without mutating the cache.

When the message also carries a tier-table version higher than the mirror has observed, the mirror's tracked version is raised — so a tier push that arrives before its companion `VersionBumped` broadcast doesn't get rejected as version-stale by the freshness gate.

### 4. The cross-chain push is protocol-funded with fail-CLOSED semantics

Pushing a tier update to N mirrors costs N times the per-chain CCIP fee. The protocol holds a dedicated `protocolBroadcastBudget` in native gas on Base. Every rollup pre-quotes the fan-out fee, debits the budget, and forwards exactly the quoted value.

If the budget cannot cover the quoted fee, the rollup *reverts*. This is intentional. The alternative — silently skipping the broadcast when budget is short — would let the protocol accept fee-bearing operations from a user while quietly letting their cross-chain tier go stale. Operators are expected to monitor the budget and top up before exhaustion; the fail-CLOSED gate ensures a half-funded protocol cannot accidentally degrade users' cross-chain experience.

### 5. Version bumps invalidate stale-version caches

When governance changes the tier-threshold table or the per-tier BPS table, every cached tier on every mirror would become stale by reference to an old version. The canonical chain's `ConfigFacet` setters increment the table version + emit a local `TierTableVersionBumped` event at the moment of the change. Mirrors learn about the new version one of two ways:

- **Implicit** (current implementation): the next per-user `TierUpdated` push carrying the new version raises the mirror's tracked version via the round-2 P1 #1 monotonic max — so a single fresh push retroactively unlocks the cache that landed before it. Cache reads against the OLD version land as tier 0 in the interim.
- **Eager** (follow-up): a dedicated `VersionBumped` CCIP broadcast at the moment of the threshold / BPS change so mirrors learn immediately rather than waiting on the next per-user push. The messenger surface (`sendVersionBumped`) ships in Sub 2.B; the producer call from the governance setter is a deferred follow-up tracked on the Sub 2 umbrella.

Either way the freshness gate rejects cache entries whose `tierTableVersion` is below the mirror's tracked version, so stale-version discounts are never applied.

### 6. Decay is enforced by the cache freshness gates, not by mirror computation

Mirrors do *not* re-derive a user's tier from local history (they have no history). They consult only the cached values and the freshness gates. So when a user partially unstakes and their effective tier drops, the cache is *not* automatically invalidated — the rollup-time broadcast on Base sends a fresh push, and the mirror writes the new (lower) cached tier. If the broadcast is missed (e.g., the protocol budget was exhausted), the mirror keeps honouring the OLD cache until one of the freshness gates fires.

The freshness gates the mirror evaluates on every read, in order:

1. `cache.effectiveTier == 0` → tier 0 (default / never pushed).
2. `cache.tierTableVersion != s.currentTierTableVersion` → tier 0 (governance moved the table).
3. `block.timestamp >= cache.tierExpirySec` → tier 0 (projected-expiry hit).
4. `block.timestamp - cache.lastUpdateSec >= cfgMirrorTierMaxAgeSec` → tier 0 (max-age backstop; default 60 days).

Gate 3's `tierExpirySec` is currently the `type(uint40).max` sentinel in every push (Sub 2.A simplified the projection to inert), so in practice the cache is honoured until either a fresh push arrives OR gate 4's max-age fires. The 60-day backstop is the absolute upper bound; a user whose cache went stale by missing pushes eventually drops to tier 0 even without further mutations — the passive degradation gate.

## What this spec does NOT cover

- The exact CCIP message payload shape (a code-level detail).
- The treasury buyback flow (T-087 Sub 3 — separate spec).
- The frontend's chain-agnostic stake UI (T-087 Sub 4 — separate spec).
- The indexer's event coverage (T-087 Sub 5 — operator concern).
- Live CCIP testnet behaviour (operator-run; see the runbook for the deploy-time configuration checklist).

## Operator-visible failure modes

- **`ProtocolBudgetExhausted(required, available)`** — rollup reverts when the budget can't cover the fan-out fee. User-facing fix: top up via `topUpBroadcastBudget()`. Anyone can fund; the operator monitors and tops up before exhaustion.
- **`NoBroadcastDestinations`** — the operator wired the canonical-side messenger but forgot to set the destination chain list on the messenger itself. Every rollup will revert with this until the destinations are configured. Catches half-finished configuration before user mutations land.
- **`StaleNonce(got, cached)`** on the mirror — a CCIP message arrived out-of-order or was replayed. Not a user-visible error — the message is rejected and CCIP re-execution is the recovery path.

## Trust model summary

The broadcast trust chain is short: canonical Diamond → canonical messenger (admin-set) → CCIP (Chainlink-secured) → mirror messenger (admin-set) → mirror Diamond. Per the CCIP cutover runbook's mainnet gates, every per-chain admin-set contract's ownership starts at the admin multisig at deploy time AND is handed to the governance timelock before mainnet routing of real value — the multisig is the deploy-time bootstrap, not the steady-state owner. The CCIP layer is operated by Chainlink with no Vaipakam-side configuration of routes or signers. There is no DVN fleet to size or risk-tune — see CLAUDE.md "Cross-Chain Security Policy" for the policy rationale.
