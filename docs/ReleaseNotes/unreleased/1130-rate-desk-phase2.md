## Thread — Rate Desk phase 2: executed-rate chart + History tab (PR TBD)

The Rate Desk gains its **executed-rate chart**: for the selected market,
the desk now draws the rates at which loans actually initiated, bucketed
over a chosen interval (hourly, four-hourly, or daily) and range (a week
to all history). The chart is governed by the design's thin-market
honesty rules, stated here in user terms: it draws only where fills
actually happened — a quiet week renders as a visible gap, never an
interpolated line; when the visible range holds only a handful of fills
(fewer than ten) the chart drops candle shapes entirely and presents the
individual prints as a stepped line with per-fill markers, saying so in
a note, because candlesticks built from two or three trades would be
theatre; hovering a bucket always discloses how many fills and how much
principal it aggregates, never bare open/high/low/close; the order
book's current quoted mid can be overlaid but is drawn dashed and
labelled "quoted mid" — a resting quote, visually never blended with
executed rates; and there is no daily percent-change ticker — the header
shows the last executed fill's rate and age instead, since a %-change
over two trades is noise sold as signal. A market with no fills says so
plainly rather than showing a fake series. On phones the chart (and
tape) sit behind a Book|Chart toggle so the ladder-and-ticket loop stays
the primary view.

The desk also gains a **History bottom tab**: every loan the connected
wallet ever participated in — any market, any status, newest first, with
role badges (lender / borrower) and links to each loan's detail page.
This closes a real gap: the existing position views key on who currently
holds a position, so a lender whose loan was repaid and claimed — or
whose position token moved to a new owner — simply vanished from every
current-holdings read. History is permanent by design: repaid, defaulted
and closed loans stay listed with their final status.

Server-side, the indexer gains the two reads behind those panels: a
per-market executed-rate candle endpoint (only buckets that contain
fills; principal totals kept precise as decimal strings; secondary-sale
bookkeeping rows excluded — a loan-sale is not a fresh rate print) and a
historical-participant endpoint backed by persisted participation rows
recorded when a loan starts and appended whenever a position token
changes hands, so participation is append-only history rather than a
mutable pointer.

The fork-tier e2e suite covers the new surfaces: the indexer stub now
answers both endpoints live from the fork's own chain state, and a new
scenario spec proves the honest-empty chart, the sparse-tape mode with
its fill-count note and last-fill header, the quoted-mid labelling, and
History's all-status persistence (a repaid loan stays listed with its
badge flipped). The chart's decision math was already unit-tested; the
spec pins the user-visible honesty surfaces.

Closes #1130. Follow-ups: phase 3 (push-invalidation keys, crossable-band
preview, signed-offer book, #1131); the desk's live driver — post, amend,
cancel, plus a chart and History pass against the deployed site and real
indexer — runs with the post-deploy live review per the DoD.
