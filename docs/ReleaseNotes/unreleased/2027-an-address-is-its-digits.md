## Thread — Support reports now redact an address however it is spelled (PR #<n>)

A support report shortens every wallet address in it before the report can
become a public issue — the first six characters, an ellipsis, the last four.
That promise is repeated to users in the Privacy Policy.

It was looking for the wrong thing. The scrubber searched for `0x` followed
immediately by forty digits, so it recognised an address only when the two
were written together. Separate them by anything at all — a space, a second
query parameter in a link, a hyphen — and the address travelled whole. So did
forty digits written with no `0x` at all, which is a full account one fixed
two-character edit from being usable.

**The scrubber now recognises the digits, not the prefix.** Forty hexadecimal
characters standing on their own are treated as an account and shortened,
wherever they appear and whatever comes before them. Where a `0x` does sit
right beside them it is still taken along, so a report reads exactly as it
did.

**Transaction hashes still come through untouched**, which is the constraint
that shaped the fix. Support needs those whole, and a hash is a longer run of
the same characters — sixty-four rather than forty — so it is not mistaken for
an account, and neither is the last forty characters of one.

**Two gaps are left open on purpose, and are written down rather than left to
be found.** A run of hex *longer* than forty is not shortened, and an address
deliberately cut in half and rejoined around a separator is not either. Both
follow from keeping hashes intact: any rule aggressive enough to catch them
also destroys every hash in every report. Neither shape occurs in an ordinary
error message — producing one takes deliberate composition by someone who
already knows the address.

There is a general point in this worth keeping. The previous rule was not
wrong about what an address looks like; it was wrong about what identifies
one. A prefix is a convention, and conventions are the part an attacker is
free to omit.
