## Thread — the indexer checks every loan-status change, and the reference subgraph is retired (PR #3003)

The platform lets a loan's status move only along a fixed diagram, and the contracts refuse every other move. An independent check from outside the contracts used to live in a reference subgraph that counted any move outside the diagram. Four of the five events it listened to no longer matched the contracts, its diagram was out of date, and nothing ever paged on its counter. The indexer now does that check itself, from the one event every status change announces.

As it scans, the indexer compares each announced move with the diagram, which the functional spec now states in full. It records three kinds of disagreement: a move the diagram does not allow, a move that does not start from the status last announced for that loan, and a second initiation of a loan it is already tracking. It keeps its own two tables (a new additive migration) and never corrects the loan records it serves, because correcting them is what would hide the drift. A replayed scan neither re-applies nor re-records anything. A loan whose initiation predates the indexer's records has its first move checked against the diagram only. The health route reports this, and how many loans were seen from initiation, alongside the violation counts.

The scheduled indexer health probe now pages on any recorded violation, on any chain, through the same alert issue and ops-chat post it uses for a stalled ingest, renamed "Indexer not healthy" to cover both. A violation stays recorded. Once an operator has investigated it, they acknowledge it by listing it in the probe workflow in a reviewed commit. The probe also fails if the health route stops reporting the check.

The reference subgraph, its export script and the deploy-script steps that ran it are removed. The security policy and the website's integrator FAQ now describe the indexer's check, and the deployment and restore runbooks are updated. The FAQ now leads with the status-change event and corrects three event descriptions that were wrong: full versus partial repayment, an event the contracts never emit, and what the fallback does with the collateral.

Closes #2337. Refs #2968 (item 7; that issue's other monitors stay open).

> Caveat: on the live testnets, loans initiated before this indexer ships are checked against the diagram only for their first move after it ships; after the all-waves fresh deploy every loan is checked from initiation.
