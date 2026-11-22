## Local testing — tooling for the review coverage pass (PR #TBD)

The review coverage pass (ReviewCoveragePassDesign) now has its tooling. Every declaration under contracts/src gets a hash of its text with comments and spacing removed. A function moved to another file keeps its coverage, a comment-only edit keeps it, and one changed operator loses it. The ledger (contracts/review-coverage/ledger.json) records, per hash, the reader-pass mark and the reviewer-loop mark as opaque review numbers. It holds no findings.

One command prints the coverage report: the share of declaration code covered by each layer and by both, per area and per file, and each uncovered declaration by name. Vendor code, the storage-layout probes and interfaces are excluded, each with its reason. The governance launch check reads the same report as JSON.

The entry check refuses a ledger entry whose hash is not a declaration at the commit it names. It also refuses a reader mark recorded by the thread that wrote the fix under review, and a new reviewer mark while the latest planted-fault run has a miss. It runs in the pre-deploy gate and fails it. The report prints beside it as a warning until the audit freeze.

The unit tool lists, for a facet or a standalone contract, the declarations it owns plus the library functions its code reaches. It leaves out what is already covered and the shared libraries, which are reviewed in their own slices. Over the size limit it splits into slices of whole declarations, and it describes each one with its lines, what it calls outside the unit (including calls through the Diamond) and who calls it. The size ladder steps the limit down after a planted-fault miss, and back up only on a full catch at the next size.

The rest connects to the private review repository. The tool makes the two branches of a review-only pull request and refuses one whose head or base differs from the pinned commit by more than the unit. It never opens one against main, and it cleans up branches. The one-way copy to the review repository refuses while that repository's workflows are enabled. It leaves out the workflow files and the dependency-update config, and checks that the copy differs from the pinned commit by exactly those paths. The review repository itself is an owner step that is not done yet.

The reports tool (#3914) and this one now follow self-calls through the Diamond by one shared rule.

Closes #3936.
