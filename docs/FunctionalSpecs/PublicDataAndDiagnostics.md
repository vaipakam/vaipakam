# Public Data and Diagnostics Functional Specification

This document consolidates public evidence and operational disclosure decisions
from [November 19](../ReleaseNotes/ReleaseNotes-2026-11-19.md) through
[November 22](../ReleaseNotes/ReleaseNotes-2026-11-22.md), 2026. It complements
[the platform](ProjectDetailsREADME.md), [the app](Alpha05ConnectedApp.md), and
[keeper operations](KeeperOperations.md). Approved [canonical sections](../CanonicalSpec/README.md)
govern covered behaviour. A specified service is not proof that it is deployed,
that a check has run, or that its history is complete.

## Public read-only feeds

- The public feed is a versioned, allowlisted, read-only view of the same
  public records the app uses. An unknown route returns not found; malformed,
  repeated, or unsupported parameters are refused. It exposes no private
  wallet convenience reads or alert preferences.
- Every answer identifies its version, network, read-start time, scan floor,
  source blocks, omissions, and coverage. It states that the data is not a
  benchmark, recommendation, executable offer, or assurance of availability.
  Missing evidence is unknown, never a zero rate or empty complete market.
- The book excludes expired offers; a caller cannot request their inclusion
  as current liquidity. Pair and term aggregates keep different assets and
  terms separate. Signed-order data is withheld when its backing cannot be
  established at the claimed block.
- Totals use each asset's raw units. They do not add amounts across assets,
  value them using a current price, or average unlike assets and terms into
  one rate. Rate candles exclude self-originated loans; records whose
  origination parties are unknown have a separate count. Address comparisons
  cannot establish whether different wallets belong to one human.
- The per-IP allowance is 120 requests per minute across public routes at the
  serving location. The limit is approximate across locations. A refusal gives
  a retry time. Missing rate-limit service configuration refuses requests;
  deployment must provide it rather than quietly serving an unlimited feed.
- The catalogue includes market data, address repayment records, and the two
  rental-rights views. Adding a named public view does not authorize arbitrary
  access to internal records.

## Address repayment records

- A request concerns one address. There is no ranking, score, colour grade,
  combined credit index, address search list, or filter for discovering people
  by their repayment record.
- A repayment belongs to the borrower that held the obligation at close, even
  when another address paid. The record distinguishes obligations opened from
  those taken over and follows ownership history through transfers.
- Outcomes distinguish on-time and late repayment, lender sale, refinance,
  liquidation, default, and unclassified outcomes. Open obligations and
  periodic interest are separate. Amounts stay per token; rentals are separate
  from token loans. Each answer names its sources, classification-rule version,
  and history floor, and includes the required limitations on coverage,
  classification, address identity, and the absence of a credit assessment.
- Self-originated loans, bookkeeping or sale vehicles, and unknown origination
  parties are excluded from ordinary counts and reported separately. If
  holder events in one block cannot be ordered confidently, the outcome is
  unclassified, never assigned to a guessed borrower.
- A recorded late-fee start determines timing when available. For legacy
  records, a positive late fee establishes lateness; closing by the original
  due time establishes on-time repayment; the rest is unclassified. Curing a
  fallback does not determine how a later close is classified. Fee totals are
  withheld when their event evidence is incomplete.

## Public rental rights

- Each rental has its own row, including concurrent rentals of the same
  multi-token asset. It identifies the collection, token, vault, owner, user,
  expiry, and quantity. A cleared user is retained as a cleared row, not
  silently confused with missing history.
- Events apply in chain order. Older events cannot overwrite a later right.
  A right is active through its expiry, inclusive, judged at the later of the
  service clock and last observed block time. The answer gives that judgement
  time and chain coverage, and discloses that an early revocation can precede
  the next indexed update.
- A query names exactly one collection, optionally a token, and a may-use
  lookup names one address. Wildcards and repeated identities are refused.
  Public chain identity does not authorize joining private preferences.
- Answers come from replayed chain rights. Historical backfill must finish
  before the service returns a rights list; it cannot present a partial list
  as complete. Removing a nonexistent or withdrawn loan removes its derived
  right as well.

## Issuer powers and token labels

- An issuer-power check records network, asset kind, block, check time,
  check version, completeness, and public evidence. It distinguishes proxy
  upgrades, forced transfer, freezing, pausing and current pause, NFT transfer
  validators, non-transferability, and vault-to-vault transfer simulation.
- Finding a function does not prove who can call it or that a power is active.
  Not finding one does not establish safety. Unknown, unchecked, failed, and
  not applicable are distinct; failed checks remain in the record. Marketplace
  conduit simulation is not run for the stated NFT-check version, and a
  missing route is unavailable, not passed.
- The issuer-check runner is not yet built at this source cutoff. Empty
  tables therefore establish no checked assets and no safety conclusion.
- Token names and symbols are untrusted plain text. Shared display rules
  remove controls, formatting characters, bidirectional and zero-width text,
  keep one line, and bound names to forty characters and symbols to twenty.
  An empty result uses the shortened address. Comparisons clean both sides;
  labels are never interpreted as links or markup. Exports neutralize leading
  spreadsheet formula characters so labels cannot execute as formulas.

## Evidence of failed transactions

- A shared error catalogue supplies known meanings and platform messages.
  Unknown errors remain unknown. An internal misuse or arithmetic panic is a
  platform fault, not invented advice for the user. Possible raising contracts
  are clues, not proof of which path ran.
- A transaction trace is the strongest path evidence. Without one, a local
  reconstruction may replay the parent state and earlier transactions and
  compare success, gas, and every event. An unmatched reconstruction is
  explicitly approximate and cannot be described as actual chain execution.
- Receipt-only evidence identifies the route's start and end and leaves the
  internal path unknown. Events undone by a revert are marked undone. Where
  a layer translates an error, both the original and translated errors are
  shown when substantiated. Keys and private node endpoints are never shown.
- Node capabilities are measured per network: transaction and call tracing,
  historical trace search, historical state calls, block receipts, and their
  cost. A successful ordinary read does not imply complete tracing support.

## Failure discovery and retention

- The failure service runs independently on the keeper machine with its own
  bounded writer identity. It has no wallet key, database credential, or
  keeper-state access. It submits only to its specific authenticated ingest
  route, with at most twenty records and bounded payloads per submission.
- Records bind to the current deployment and cannot precede its deployment
  block. Discovery names its source: keeper, explorer, audit, historical trace
  search, or block scan. Decoding separately names trace, reconstruction,
  replay, or none. Better evidence may replace weaker evidence; a weaker
  result cannot overwrite a stronger one.
- A replaced block is marked rather than erased. The same transaction mined
  again belongs to a separate block record. Gaps, late discovery, and failed
  scans are visible; an unavailable node retries without downgrading evidence.
- BNB testnet discovery can use historical trace search. Base and Arbitrum
  use direct explorer discovery every five minutes, other explorer scans
  hourly, with a random audit every thirty minutes and a daily full audit.
  Audit results measure missed records; schedule alone proves no completeness.
- Without an explorer key, the audit path is the source until a keeper-source
  decision is recorded; the declared sampling fraction remains visible.
  Checkpoint changes require two confirming reorg reads. Local reconstruction
  is operator-only. Installing the service or its ingest token does not prove
  any production instance is running.
- Failure records remain for 400 days and have nightly backups. Restore
  preserves the whole evidence payload, including records split into pieces,
  and does not silently discard inconvenient or unreadable rows.

## Event, state, and build provenance

- Platform-contract event history preserves decoded events or their raw data,
  including settings changes in transaction order. Code changes use the actual
  selector timeline. An end-of-block settings read states only end-of-block
  context; it cannot establish the setting used earlier within a transaction.
- Historical state still unread after three attempts is recorded as unknown.
  Coverage starts at the first indexed block without a promise of earlier
  backfill. Reorg and deployment replay clear affected derived state; private
  service history stays separate. Price-guard settings history remains a
  follow-up at this source cutoff.
- A derived row's source block, transaction order, and log order advance
  monotonically. A pinned state read is end-of-block evidence, without an
  invented event position. A head read lacking a known block has unknown
  provenance; a later attributed read can replace it. An unattributed write
  clears stale attribution rather than inheriting it from an older value.
- Existing rows remain unattributed until refreshed. Signed orders begin as
  signed evidence without an invented chain birth block; replay resets their
  provenance and reapplies actual events. Reward and recycling provenance
  remain follow-ups, so the system cannot claim every table is attributed.
- Backing measurements distinguish settled, estimated, and not recorded.
  Estimated backing is not confirmed backing. A confirmed measurement can
  replace a newer-block estimate; an estimate cannot displace fresh confirmed
  evidence, although a newer estimate may replace stale confirmed evidence.
- Build history records successive serving periods, including a rollback as a
  new period. Dirty or unstamped sources remain explicit. The indexer, agent,
  and scheduled services report their own build; failure evidence names its
  bundle commit. Public website, current app, and alpha05 stamps are read
  uncached hourly. Keeper build coverage remains a follow-up. Build records
  contain no users, remain for the deployment lifetime, and are backed up.

## Deployment and restore assurance

- A rehearsal is explicitly local, records whether it uses a fork, and keeps
  scratch output separate from committed records, production data, and keys.
  Its evidence binds the commit, tracked tree, inputs, and planned steps.
  Uncovered steps cannot receive a successful overall verdict. Every signed
  role, expected result, and actual receipt is accounted for.
- Reused deployment identities are re-established from current deployment
  records, not inherited from stale environment settings. Readback names the
  desired state, current fees, roles, funding, anchor, cap day, peer settings,
  routed capabilities, and complete artifacts it actually checked. An allowed
  unset value needs its reason; unread does not become zero.
- Token-pool limits and administration, token cross-chain registration,
  clearance-feed bindings, and keeper arming are not all covered by these
  readbacks. A mainnet venue requires owner-accepted evidence. A relay rehearsal
  checks actual router, token, limit, message, gas, and risk-curse behaviour,
  while disclosing its substitute receiving component; it cannot prove live
  network verification, delay, or manual execution.
- Gas measurements are bounded observations. The instant-borrow default-sized
  case still has an open capacity concern; a successful test suite does not
  establish that every permitted batch fits a network's block capacity.
- Backups preserve legal-hold decision times, record identities, and ordering.
  Restore rejects invalid rows individually and preserves valid historical
  decisions. All retention tiers have a minimum of eight days; a thirty-one-day
  monthly setting stays thirty-one days. Daily observation covers all versions.
- A backup credential is confined to one bucket with the allowed capabilities
  and no prefix restriction; multi-bucket authorization is refused, including
  the newer credential form. Environment settings are data, never executable
  startup instructions. Loading either accepts the complete permitted settings
  or changes none of them.
