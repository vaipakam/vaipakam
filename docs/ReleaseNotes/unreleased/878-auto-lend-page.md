## Thread — Auto-lend moved to its own page (PR #878)

The Auto-lend (standing lender intent) surface has moved off the landing
Dashboard onto a dedicated **Auto-lend** page (`/auto-lend`), reachable from the
app sidebar (Advanced group, next to Keepers — an auto-lend intent delegates a
keeper to fill on the lender's behalf). Since the multi-intent list and Manage
controls landed, the feature had grown from a single card into a full management
surface that crowded the Dashboard.

The full surface now lives on that page: create a standing intent, see the
"Your auto-lend intents" list across every pair you run, and manage each one.
Every on-chain write still flows through the same audited auto-lend card — this
change only relocates and hosts it; there is no new mutation path, and the
list's "Manage" deep-link (which retargets the card and scrolls to it) works on
the new page exactly as it did on the Dashboard.

In its place the Dashboard shows a compact summary widget — the wallet's
standing-intent count (active plus paused) with a link to the page. It appears
only once the wallet actually holds a standing intent; first-time discovery is
via the sidebar's Auto-lend entry. Opening the page without a connected wallet
shows a connect prompt, and — since the create/fund/withdraw paths are
sanctions-gated — the page carries the same wallet sanctions banner the
Dashboard used to show above these cards. Both the page's cards and the
Dashboard widget stay hidden on chains where the intent facet set isn't
deployed, so neither renders a dead surface.

Closes #878.
