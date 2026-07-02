## Tooling — curated facet-upgrade scripts no longer risk a split Diamond (#778, #779)

The curated "replace a stale facet" / "redeploy specific facets" operator scripts
each hand-maintained their own partial list of which function selectors to cut
into the Diamond. Those lists had drifted below the facets' real surface — the
Oracle, VaultFactory and Profile lists were each missing selectors that exist on
the live facet. Running such a script would `Replace`-cut only the listed
selectors and leave the unlisted ones pointing at the old facet bytecode, quietly
splitting one facet across two implementations (most dangerous around the
sanctions/keeper controls and shared vault state).

The per-facet selector lists for those facets now come from a single shared
source, and a new guardrail test pins that source to each facet's compiled ABI —
so if a facet gains or loses an external function, the test fails until the one
shared list is updated, rather than a live upgrade silently splitting the Diamond.
Building this even surfaced two selectors that the previous "canonical" reference
list had itself been missing.

No production/runtime behaviour changes — this hardens the operator upgrade
tooling and its safety checks only.
