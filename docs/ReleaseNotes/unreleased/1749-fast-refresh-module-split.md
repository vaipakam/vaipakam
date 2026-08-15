## Connected app — editing a page no longer reloads the whole app (PR #1751)

Seven files in the connected app exported a React component *and* something
that is not a component — a hook, a set of protocol constants, a pure string
helper, a data mapper. That combination defeats Fast Refresh: when the file is
edited the dev server cannot prove the non-component exports are unchanged, so
instead of hot-swapping the component it reloads the whole page. In practice
that meant a one-character change to the offer book, the keeper settings page,
the locale resolver, or any of the three context providers dropped the
connected wallet session, the open modal, and every bit of scrolled-to state,
and the developer had to walk back to where they were.

The non-component halves have moved to modules of their own, next to the other
things of their kind rather than inside a page: the locale-prefix helpers now
sit with the rest of the i18n code, the keeper permission bits with the other
protocol constants, and the offer row shape with the offer libraries — where
three unrelated callers were already reaching into the offer book page to find
it, which is the clearest sign it never belonged there. The three data-freshness
/ watermark / realtime-push providers keep all of their logic; only the context
handle and its reader hook moved to a sibling module.

No user-facing behaviour changes and no intended behaviour changes — every
moved definition is byte-for-byte what it was, and the test suite passes
unchanged. This clears the twelve `react-refresh/only-export-components`
warnings tracked in #1749; the `set-state-in-effect` half of that issue is
untouched and still open.
