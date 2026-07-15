# HINT_CAP retune measurement procedure (#1245)

`HINT_CAP = 32` (`apps/indexer/src/pushHints.ts`) is the launch value
for the scoped-push-hint id caps (RPC read-diet PR D, design §4.2.2).
It was chosen conservatively without per-scan volume data; #1245 is the
retune, which the issue gates on **real rehearsal load existing on the
testnet**. As of this writing that load does not exist, so the number
cannot be picked yet — this PR ships the **measurement rail** so the
data is collected the moment load arrives, and documents how to read it
and pick the cap.

## Why the cap is low-stakes (context for the retune)

The hint contract is truncation-honest: a hint may only ever NARROW a
client's refetch when it is COMPLETE. So the cap is a **performance**
knob, never a correctness one:

- **Too low** → more scans flagged `truncated` → clients fall back to
  the coarse key and do the pre-PR-D amount of work. Never wrong, just
  less of the scoping win.
- **Too high** → larger hint payloads in the push frame (a handful of
  extra ints). Negligible bandwidth.

So the retune is pure optimization: pick the smallest cap that keeps the
overwhelming majority of real frames un-truncated.

## The measurement rail

`pushHintStats(logs)` (`pushHints.ts`) reports, per scan, the **pre-cap**
distinct loan/offer id counts (the wire `collectPushHints` slices these
away) plus a truncation-cause breakdown. The scan tail
(`chainIndexer.ts`) logs one structured line per non-trivial scan:

```
[hint-telemetry] {"chainId":84532,"blocks":[123,140],"loanIdCount":3,
  "offerIdCount":1,"linkCount":1,"cap":32,"truncated":false,
  "causes":{"loanCapExceeded":false,"offerCapExceeded":false,
    "unmappableEvent":false,"handledNoId":false,"linkCapExceeded":false,
    "linkNoParty":false,"stubHeal":false}}
```

`loanIdCount` / `offerIdCount` are the TRUE sizes before the cap, so the
log shows how far a busy frame overshoots 32 — the exact input the cap
choice needs.

## Collecting the data (once rehearsal load exists)

1. Start a rehearsal-load run (many concurrent offers / accepts / fills
   / cancels on the testnet Diamond).
2. Capture the telemetry stream over the window:
   ```bash
   cd apps/indexer
   wrangler tail --format json \
     | grep --line-buffered hint-telemetry \
     > /tmp/hint-telemetry.ndjson
   ```
   (Or configure Logpush to a bucket for a longer window — same lines.)
3. Let it run long enough to include the busiest expected frames
   (a spammed pair, a batch nonce burn, a mass-expiry tick).

## Picking the cap (sub-task 1)

From the captured lines:

```bash
# The pre-cap id-count distribution (max of loan/offer per frame):
jq -r '[.loanIdCount,.offerIdCount]|max' /tmp/hint-telemetry.ndjson \
  | sort -n | uniq -c
# The 95th percentile — a cap at/above this keeps ≥95% of frames
# un-truncated by the CAP cause (other causes are separate):
jq -s 'map([.loanIdCount,.offerIdCount]|max)|sort|.[(length*0.95|floor)]' \
  /tmp/hint-telemetry.ndjson
```

Pick `HINT_CAP` at or just above that P95. If the distribution has a
long thin tail (a few frames with hundreds of ids), do NOT chase it —
those frames SHOULD truncate; the coarse fallback is correct for them.

## Reading the truncation-cause mix (sub-task 2)

```bash
# What actually drives truncation — is it the cap, or unmappable
# (signed-desk Transfer / SignedOffer* lifecycle) traffic?
jq -r 'select(.truncated)|.causes|to_entries[]|select(.value)|.key' \
  /tmp/hint-telemetry.ndjson | sort | uniq -c | sort -rn
```

- If **`unmappableEvent` dominates**, raising `HINT_CAP` won't help —
  those frames truncate on the signed-lifecycle / Transfer rule, not on
  size. The issue's second bullet then applies: consider mapping
  `orderHash → maker offerId` server-side so signed-desk scans stop
  degrading to coarse. That is a separate change; scope it only if the
  data shows signed traffic is the dominant truncation cause.
- If **`loanCapExceeded` / `offerCapExceeded` dominate**, the cap is the
  lever — set it per the P95 above.
- `stubHeal` truncations are inherent (a heal mutates a row with no log
  this scan) and unaffected by the cap.

## Confirming the scoping win (sub-task 3)

The fraction of frames a healthy idle tab can SKIP is the fraction that
are BOTH un-truncated AND irrelevant to that wallet — the client-side
`pushHintScope` rule (`apps/alpha02/src/chain/pushHintScope.ts`). The
server-side proxy for "skippable-in-principle" is the un-truncated
fraction:

```bash
jq -s 'group_by(.truncated)|map({truncated:.[0].truncated,n:length})' \
  /tmp/hint-telemetry.ndjson
```

A high un-truncated fraction means the scoping is doing its job; a low
one under a size-dominated cause means the cap is too low.

## Shipping the retune

When the data justifies a change, it is a one-line edit to `HINT_CAP`
plus a note here recording the measured distribution and the chosen
value. The measurement rail (this telemetry) stays — it is the same
surface a future re-retune reads.
