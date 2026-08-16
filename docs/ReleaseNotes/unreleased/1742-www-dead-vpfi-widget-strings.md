## Marketing site — the retired VPFI buy widget's strings leave the translation bundles

The public marketing site's VPFI page once carried the interactive
deposit/withdraw widget. That widget moved to the connected app, but its
strings stayed behind in the marketing site's translation bundles: connect
prompts, unsupported-network notices, the three numbered step headings, and
the button labels and failure messages for every action it used to offer.

Twenty-five keys in all, none of them read by anything the marketing site
renders — the page uses only its title and the pre-connect explainer. They
shipped to every visitor regardless, in the English bundle that loads on
first paint and again in each translated bundle.

Four of them named a purchase — a button reading "Buy VPFI", its in-flight
and failure counterparts, and a timeout notice about returned funds. The
English copy on this page had already been reworded away from purchase
language by the securities excision, but these particular strings were part
of the widget rather than the page, so the rewording never reached them, and
seven of the translated bundles still carried the purchased-verb phrasing
their translators had been given. Nothing rendered them; they were
nonetheless the removed surface, asserted in the shipped bundle.

All twenty-five are gone from all ten language bundles. Nothing the page
displays changes.

While confirming which keys were dead, a larger version of the same drift
came into view: the marketing site's bundles carry fifty-four further
namespaces that belong entirely to the connected app — well over a thousand
strings the marketing site never renders. That is filed separately; this
change stays inside the one namespace the page actually uses.
