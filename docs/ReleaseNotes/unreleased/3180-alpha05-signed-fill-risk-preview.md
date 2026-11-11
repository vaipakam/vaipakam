## alpha05: a signed fill's risk-access check shown before signing (#3577)

The fill review on the new app's rate desk now reads the protocol's own preview of the risk-access check for a signed order, which the contracts gained in #3582. Before, a signed order had no such preview, so the check was made only by the dry run after the taker had signed the terms.

The preview reports the maker's block and the taker's separately. When the maker's own risk setting no longer covers the pair, the review says so and nothing can be signed or sent, because no step of the taker's can clear it. When the taker's setting does not cover it, the review offers the step that clears it, for the exact pair the protocol names, before anything is signed, the same way a stored offer's review does.

Where the preview cannot be read, the review keeps the earlier behaviour and says so: the dry run after signing makes the check, and a refusal there offers a step only when the refusal names the taker. The test networks are in that state until their next contract refresh carries the new view.
