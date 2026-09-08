## Old links keep working — and stop quietly undoing the protections around them

The connected app moved to its own address, and the old deployment is
meant to be retired by pointing everything at the new one. That promise
only holds if the addresses people already have still land somewhere
sensible, and a sweep of what the retired app actually served turned up
several that would not have.

Three were simply missing. The NFT verifier had been renamed, so every
saved link to its old address would have arrived at a not-found page.
The VPFI vault had been renamed too, and its links often carried a
pointer to a particular step, which was being dropped even where the
address itself resolved. And the protocol console had been reachable
under an older name, along with its documentation — both gone.

The larger one was a whole shape of address rather than a single page.
The retired app put the reader's language into the address itself, so
every page it served existed under a dozen or more spellings. Those are
now answered by stripping the language from the address and continuing
to the real page — and, because a link that names a language is asking
for that language, the app switches to it rather than silently answering
in whatever the reader last used. That behaviour is inherited from the
app being replaced, and it has a consequence worth knowing: the choice
is remembered afterwards, so following one old link changes the reader's
language until they change it back. Matching the old behaviour was the
conservative call; narrowing it is a product decision, so it is flagged
rather than taken.

**What made this more than a list of redirects is that two protections
were being walked straight past.**

The first is the rule that keeps people from being locked out of their
own money. When the terms of service change, the app withholds the
pages that would let someone take on new commitments, and deliberately
never withholds the ones that let them repay, claim, or withdraw. But a
redirect is itself a page — so an old address pointing at repayment was
being held behind the terms prompt, and the redirect that would have
taken the reader to the unrestricted page never got to run. Someone
following an old bookmark met a consent screen on their way to paying
off a loan. The rule now looks at where an address leads rather than at
how it is spelled, and the language-prefixed forms are covered too.
Nothing is loosened by that: an old address leading to a page that
creates new commitments is still withheld, exactly as its current form
is.

The second is the instruction that keeps private pages out of search
results. That instruction is attached to exact addresses, and the
language-prefixed versions are not those addresses — so a search engine
that does not run the app would have received an ordinary, indexable
page for a personal position or claim, purely because the link carried a
language in it. Every such address is now excluded, with one rule rather
than one per language.

That last detail is not tidiness. The file carrying those instructions
has a hard limit on how many it may contain, and writing one pair per
language took it past that limit — which failed the deployment build
twice, with an error nobody could read from the build system. The single
rule fits comfortably and never grows. What makes one rule safe is that
every page this app asks to have listed in search is a single top-level
address, so a rule aimed at everything deeper cannot catch one of them;
that is now checked automatically, so publishing a nested public page in
future has to be a deliberate decision rather than an accident that
quietly hides it from search.
