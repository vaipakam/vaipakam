## The live review's own verdict rules can now be tested

The post-deploy review of the lender position page decides three things about
each page it looks at: what counts as a product failure, what counts as
something it could not observe, and what is merely worth printing. That decision
sat inside the reporting loop with no way in from outside, so nothing could hand
it a made-up observation and check the answer.

Every defect found in those rules so far was found by reading them. One of them
hid a genuine dead button whenever an unfamiliar row appeared beside it. Another
sent a reader looking for a control that had never been rendered. A third was
keyed on a sentence the review itself writes, so rewording that sentence would
have quietly switched the rule off. None of the three could have been caught by
running the review, because the live chain never produces the situations they
describe — the same reason an earlier comparison in this review shipped through
four rounds having never once executed.

The rules now live in their own module with tests that construct the
observations directly, which is all they ever needed: an observation is a plain
record, so none of this required a browser or a chain. The order in which the
two verdicts are ranked stays where it was, in the review itself.

Writing the tests turned up one defect immediately, and it was introduced by the
extraction rather than inherited: the reason a page is unobservable is now the
verdict itself rather than a note printed alongside it, so a page blocked for no
stated reason would have read as not blocked at all. It cannot now be silent.
