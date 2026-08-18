## The machine-readable documentation stops claiming a currency it does not have

The site publishes machine-readable copies of its documentation for automated
consumers. Those copies have no runtime, so the tunable figures in them are
resolved when the files are produced — and what they resolve to is the value
set shipped with the site, which is pinned to the protocol's compiled starting
rates. A governance retune moves the live configuration, not those starting
rates, so these files do not follow a retune even when the site is rebuilt.
The rendered pages do, when their own read of the published configuration
succeeds — a page whose read fails shows the same shipped values these files
carry, which is its designed fallback.

The specification said these copies were "current as of their build" and
carried "the same resolved values as the human-facing pages". Both claims are
now false in exactly the situation that matters — after the first retune —
and the first is false in a subtle way: rebuilding does not refresh the
figures, so even "as of the build" promised more than the files deliver.

Both passages now say what the files actually carry, that they match the
rendered pages only while the published configuration equals the shipped
values, and that the divergence after a retune is specified and stated rather
than a defect. A code comment repeating the same wrong claim is corrected with
them.

What is deliberately not decided here: whether these files should instead
fetch the published configuration when they are produced. That would make
publication depend on a network read, with everything that implies for a build
the configuration service cannot answer, and it needs a considered yes or no
rather than a side effect of a wording fix. The specification now names that
as an open decision, so the honest description holds either way.
