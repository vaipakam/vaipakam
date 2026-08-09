## Every live review drive now says whether it found a defect or was simply unable to look

The live tier of the alpha02 review suite is a set of drives pointed at the
deployed site. Each one ends with a verdict, and the batch report collects
them. Two of those verdicts mean opposite things to whoever reads the
report: "this surface is broken" sends someone to fix the product, while
"this drive could not run" sends someone to fix the environment and then
review the surface, which is still unreviewed.

Only two of the fourteen drives actually distinguished them. The other
twelve reported both as a defect. An unreachable site, a dead price feed,
an absent set of test credentials, a sandbox with no usable browser, a
stale copy of the deployed addresses — all of them arrived in the report as
a product regression on the surface that happened to be under review. That
costs twice: someone hunts a bug that does not exist, and the habit of
seeing defects that are not defects trains reviewers to skim past the one
that is real.

All twelve now distinguish them, and the report says so rather than
implying it. The batch runner keeps its list of drives that promise the
distinction — the promise is what makes the vocabulary trustworthy — but it
now also names any drive missing from that list the moment the batch
starts, instead of silently downgrading its verdict later on.

**What counts as "could not look".** A drive's first page load is its
reachability check, so a site that never answers blocks it, while a route
that fails after the site has already served pages stays a finding — a
broken route is exactly the kind of regression these drives exist to
catch. Reference data a drive reads rather than checks — the deployed
addresses, the contract interface descriptions, an artifact a flag points
at — blocks it, because a stale copy leaves the drive with nothing to
compare against. So does a configuration selector that names nothing, and
so does a test wallet without the funds the drive has to commit.

**The one that was hiding in plain sight.** The gasless-posting drive needs
funds in the maker's vault before it can post anything. Without them it
reported that the posting flow had regressed and told the reader to top up
the vault in the same breath — a defect claim and its own refutation, in
one line. It now blocks. The equivalent check was missing entirely from the
sibling order-posting drive, which would instead fail somewhere mid-post
with the underlying reason several steps behind it; that drive now checks
the balance before it even opens a browser, so an underfunded run costs
nothing and says exactly what it needs.

**Where the line was deliberately NOT drawn.** One drive resets a leftover
setting before it starts. Reading that setting can fail because the chain
is unreachable — that blocks. Writing it can fail because the chain
refused a change that should have been accepted — and that is evidence, so
it stays a finding. Reclassifying it would have hidden a real defect behind
a "re-run this later" verdict, which is the same mislabelling this change
exists to remove, pointed the other way.

**One rule that deliberately runs the other way.** A drive that checks each
of nine languages in turn opens a fresh browser for each one and collects
what it finds as it goes. If the browser fails to start on the sixth
language after a real translation fault was found on the second, saying
"could not look" about that run would be false — something was found, and
reporting otherwise would bury it. That drive keeps deciding its own
verdict: a real finding outranks a later setup problem, and only a run
that found nothing at all reports as blocked. The first pass of this work
removed that rule by accident, which is exactly the kind of quiet reversal
the review round exists to catch.

**How it was checked.** Each class of blocking condition was forced
deliberately — an unreachable target, a missing credential file, an
unusable browser, a corrupted address bundle, an emptied interface bundle,
an unfunded wallet, a mis-set selector — and every drive confirmed to
report "could not look". The opposite direction matters just as much: a
drive that blocked on everything would look like success in that test
alone, so each was also pointed at a page that genuinely was served but
carried the wrong content, and confirmed to still report a finding; and two
read-only drives were run against the real site and confirmed to still
pass. The batch report was checked to render all three verdicts distinctly,
including the new warning for an unregistered drive.
